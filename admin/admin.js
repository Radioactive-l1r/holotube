// Admin console: create stations, print their QR codes, set the quiz.
//
// Deliberately does not reuse ../js/api.js. That module attaches the visitor's
// Bearer token from localStorage on every request, which is right for the
// player-facing site and wrong here -- admin routes want X-Admin-Key instead.
// The key lives in sessionStorage so it disappears when the tab closes.
//
// The key is typed in by the operator and never appears in this file or in any
// committed file. This page is published on the public site, so anything hard
// coded here would be readable by anyone.

const KEY_STORE = "holotube.admin_key";
const LETTERS = ["A", "B", "C", "D"];

const gate = document.getElementById("gate");
const consoleEl = document.getElementById("console");
const gateError = document.getElementById("gate-error");
const keyForm = document.getElementById("key-form");
const keyInput = document.getElementById("key");

const stationsBody = document.querySelector("#stations tbody");
const stationsEmpty = document.getElementById("stations-empty");
const createForm = document.getElementById("create-form");
const createError = document.getElementById("create-error");

const detail = document.getElementById("detail");
const detailCode = document.getElementById("detail-code");
const detailToken = document.getElementById("detail-token");
const qrBox = document.getElementById("qr");
const downloadQr = document.getElementById("download-qr");
const copyToken = document.getElementById("copy-token");

const quizForm = document.getElementById("quiz-form");
const promptInput = document.getElementById("prompt");
const optionsBox = document.getElementById("options");
const quizError = document.getElementById("quiz-error");
const quizSaved = document.getElementById("quiz-saved");
const quizNone = document.getElementById("quiz-none");

let selected = null;
let qrDataUrl = "";

function adminKey() {
  return sessionStorage.getItem(KEY_STORE) || "";
}

function setNote(el, message) {
  el.textContent = message || "";
  el.hidden = !message;
}

async function adminApi(path, options) {
  const opts = Object.assign({ method: "GET" }, options || {});
  opts.headers = Object.assign({ "X-Admin-Key": adminKey() }, opts.headers || {});
  if (opts.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }

  const response = await fetch(API_URL + path, opts);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed (" + response.status + ")");
    error.status = response.status;
    // The API sends a machine-readable code on the refusals a UI has to tell
    // apart (no_active_question vs unknown_station). Carried through so callers
    // can branch on it instead of matching the message text.
    error.code = data.code || null;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------
// QR

// Access tokens are digits only, so numeric mode packs them into a much
// smaller square than alphanumeric -- which matters when the printed code has
// to be readable from a few feet away on a phone camera.
function renderQr(token) {
  let qr;
  try {
    qr = qrcode(0, "M");
    qr.addData(token);
    qr.make();
  } catch (error) {
    // Numeric mode cannot encode a non-digit payload. Fall back rather than
    // showing nothing, so an unexpected token still produces a scannable code.
    qr = qrcode(0, "M");
    qr.addData(String(token));
    qr.make();
  }
  // qrcode-generator 1.4.x takes (cellSize, margin) positionally here. Unlike
  // createSvgTag, createDataURL has no options-object form, so passing one leaves
  // cellSize as an object, makes `size` NaN, and gifImage throws
  // "Invalid array length" on new Array(NaN). cellSize 8, margin 4.
  qrDataUrl = qr.createDataURL(8, 4);
  // createSvgTag does accept an object, which is how `scalable` is reached --
  // otherwise the SVG gets fixed width/height attributes and stops filling the box.
  qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  downloadQr.href = qrDataUrl;
  downloadQr.download = "station-" + selected + ".png";
}

function buildOptionInputs() {
  optionsBox.innerHTML = "";
  LETTERS.forEach((letter) => {
    const row = document.createElement("div");
    row.className = "option-row";

    const id = "opt-" + letter;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "correct";
    radio.id = id;
    radio.value = letter;

    const label = document.createElement("label");
    label.setAttribute("for", id);
    label.textContent = letter;

    const text = document.createElement("input");
    text.type = "text";
    text.maxLength = 200;
    text.id = "text-" + letter;
    text.placeholder = "Option " + letter;

    row.append(radio, label, text);
    optionsBox.append(row);
  });
}

// ---------------------------------------------------------------------------
// rendering

async function loadStations(preferCode) {
  try {
    const data = await adminApi("/stations");
    stationsBody.innerHTML = "";

    if (!data.stations.length) {
      stationsEmpty.hidden = false;
    } else {
      stationsEmpty.hidden = true;
    }

    data.stations.forEach((station) => {
      const tr = document.createElement("tr");
      tr.dataset.code = station.station_code;

      const code = document.createElement("td");
      code.textContent = station.station_code;

      const name = document.createElement("td");
      name.textContent = station.display_name;

      const status = document.createElement("td");
      status.textContent = station.occupied
        ? "occupied — " + (station.visitor_name || "someone")
        : "free";
      status.className = station.occupied ? "busy" : "free";

      const quiz = document.createElement("td");
      quiz.textContent = "—";
      quiz.dataset.role = "quiz";

      const actions = document.createElement("td");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ghost small";
      open.textContent = station.station_code === selected ? "Reload" : "Open";
      open.addEventListener("click", () => selectStation(station.station_code));
      actions.append(open);

      tr.append(code, name, status, quiz, actions);
      stationsBody.append(tr);
    });

    // Annotate the quiz column without blocking the table on N round trips.
    await Promise.all(data.stations.map(markQuiz));

    const next = preferCode || selected;
    if (next && data.stations.some((s) => s.station_code === next)) {
      if (next !== selected || detail.hidden) {
        selected = next;
      }
      await selectStation(next, data.stations);
    } else {
      selected = null;
      detail.hidden = true;
    }
  } catch (error) {
    if (error.status === 403) {
      // Wrong or missing key. Drop it so the next attempt starts clean.
      sessionStorage.removeItem(KEY_STORE);
      showGate("That admin key was not accepted.");
      return;
    }
    setNote(createError, error.message);
  }
}

async function markQuiz(station) {
  const cell = stationsBody.querySelector(
    'tr[data-code="' + station.station_code + '"] [data-role="quiz"]'
  );
  if (!cell) {
    return;
  }
  try {
    await adminApi("/stations/" + encodeURIComponent(station.station_code) + "/question");
    cell.textContent = "active";
  } catch (error) {
    // Branch on the code, not the status: a 404 covers both "this station does
    // not exist" and "it exists but has no quiz yet", and only the latter should
    // read as "none". A misconfigured code is an operator problem worth
    // surfacing, not silently drawn as an unconfigured station.
    cell.textContent =
      error.code === "no_active_question" ? "none"
      : error.code === "unknown_station" ? "missing!"
      : "?";
  }
}

async function selectStation(code, knownStations) {
  selected = code;
  detail.hidden = false;
  detailCode.textContent = code;
  setNote(quizSaved, "");
  setNote(quizError, "");

  const all = knownStations || (await adminApi("/stations")).stations;
  const station = all.find((s) => s.station_code === code);
  if (!station) {
    return;
  }

  detailToken.textContent = station.access_token;
  renderQr(station.access_token);

  try {
    const data = await adminApi("/stations/" + encodeURIComponent(code) + "/question");
    quizNone.hidden = true;
    promptInput.value = data.question.prompt;
    LETTERS.forEach((letter) => {
      document.getElementById("text-" + letter).value = data.question.options[letter];
    });
  } catch (error) {
    quizNone.hidden = false;
    promptInput.value = "";
    LETTERS.forEach((letter) => {
      document.getElementById("text-" + letter).value = "";
      document.getElementById("opt-" + letter).checked = false;
    });
  }
}

// ---------------------------------------------------------------------------
// auth gate

function showGate(message) {
  gate.hidden = false;
  consoleEl.hidden = true;
  setNote(gateError, message || "");
  keyInput.focus();
}

function showConsole() {
  gate.hidden = true;
  consoleEl.hidden = false;
}

keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setNote(gateError, "");
  sessionStorage.setItem(KEY_STORE, keyInput.value.trim());
  keyInput.value = "";
  // loadStations validates the key; on 403 it bounces back to the gate.
  showConsole();
  await loadStations();
});

document.getElementById("refresh").addEventListener("click", () => loadStations());

document.getElementById("disconnect").addEventListener("click", () => {
  sessionStorage.removeItem(KEY_STORE);
  selected = null;
  detail.hidden = true;
  showGate();
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setNote(createError, "");
  const button = createForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await adminApi("/stations", {
      method: "POST",
      body: {
        station_code: document.getElementById("new-code").value,
        display_name: document.getElementById("new-name").value
      }
    });
    createForm.reset();
    await loadStations(data.station_code);
  } catch (error) {
    setNote(createError, error.message);
  } finally {
    button.disabled = false;
  }
});

quizForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setNote(quizError, "");
  setNote(quizSaved, "");

  const correct = optionsBox.querySelector('input[name="correct"]:checked');
  if (!correct) {
    setNote(quizError, "Tick which option is correct.");
    return;
  }

  const body = { correct_option: correct.value, prompt: promptInput.value };
  LETTERS.forEach((letter) => {
    body["option_" + letter.toLowerCase()] = document.getElementById("text-" + letter).value;
  });

  const button = quizForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await adminApi(
      "/stations/" + encodeURIComponent(selected) + "/question",
      { method: "POST", body: body }
    );
    const replaced = data.replaced && data.replaced.length;
    setNote(quizSaved, "Saved." + (replaced
      ? " Replaced " + replaced + " earlier question" + (replaced > 1 ? "s" : "") +
        "; existing answers were kept."
      : ""));
    await loadStations(selected);
  } catch (error) {
    setNote(quizError, error.message);
  } finally {
    button.disabled = false;
  }
});

copyToken.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(detailToken.textContent);
    copyToken.textContent = "Copied";
    setTimeout(() => { copyToken.textContent = "Copy"; }, 1200);
  } catch (error) {
    // Clipboard access needs a secure context; the digits are selectable anyway.
    copyToken.textContent = "Select and copy";
  }
});

buildOptionInputs();

// Picks up a key left in sessionStorage by a reload, so a refresh mid-edit
// does not force a retype.
if (adminKey()) {
  showConsole();
  loadStations();
} else {
  showGate();
}
