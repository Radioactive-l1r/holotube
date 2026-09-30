// Screen flow: gate (name + number) -> lobby (scan) -> station (claimed).
//
// On load, a token in localStorage is exchanged for the visitor's record, then
// for whichever station they are holding. The name shown always comes from the
// server's stored value, never from whatever was typed, so the two can never
// disagree.
//
// Station lifecycle, which is the part worth reading before changing:
//
//   scan QR -> POST /stations/claim -> hold the seat
//                                    -> poll /stations/me every 30s to stay
//                                       alive and to notice being reclaimed
//   submit answer (game client) -> the seat frees itself server-side
//   press Done                  -> POST /stations/{code}/release
//
// The two release paths are independent, so this page must tolerate finding
// out it no longer holds a seat at any moment. It does that by treating a null
// station from the poll as normal rather than exceptional, and by only ever
// releasing a seat it still believes it holds.

const POLL_INTERVAL_MS = 30000;

const gate = document.getElementById("gate");
const lobby = document.getElementById("lobby");
const stationView = document.getElementById("station");

const form = document.getElementById("register-form");
const nameInput = document.getElementById("name");
const numberInput = document.getElementById("number");
const submitButton = document.getElementById("submit");
const gateError = document.getElementById("gate-error");

const lobbyName = document.getElementById("lobby-name");
const scanButton = document.getElementById("scan");
const reader = document.getElementById("reader");
const scanStatus = document.getElementById("scan-status");
const lobbyError = document.getElementById("lobby-error");
const manualForm = document.getElementById("manual-form");
const manualCode = document.getElementById("manual-code");

const stationName = document.getElementById("station-name");
const stationState = document.getElementById("station-state");
const doneButton = document.getElementById("done");

// Which seat this page believes it holds. The single source of truth for
// "am I seated", so the poll, the release and the view switch cannot disagree.
let heldStation = null;
let pollTimer = null;
let scanner = null;

function show(el) {
  el.hidden = false;
}

function hide(el) {
  el.hidden = true;
}

function setError(box, message) {
  box.textContent = message;
  if (message) {
    show(box);
  } else {
    box.textContent = "";
    hide(box);
  }
}

function setStatus(box, message) {
  box.textContent = message;
  if (message) {
    show(box);
  } else {
    box.textContent = "";
    hide(box);
  }
}

// ---------------------------------------------------------------------------
// views

function showGate() {
  stopPolling();
  heldStation = null;
  hide(lobby);
  hide(stationView);
  show(gate);
}

function showLobby(visitor) {
  stopPolling();
  heldStation = null;
  stopScanner();
  lobbyName.textContent = visitor.name;
  setError(lobbyError, "");
  setStatus(scanStatus, "");
  hide(stationView);
  hide(gate);
  show(lobby);
}

function showStation(station) {
  stopScanner();
  heldStation = station.station_code;
  stationName.textContent = station.display_name;
  setStatus(stationState, "");
  hide(gate);
  hide(lobby);
  show(stationView);
  startPolling();
}

// ---------------------------------------------------------------------------
// scanner

// html5-qrcode has to be torn down by hand. A scanner left running keeps the
// camera light on after the user has left the screen, and on iOS the browser
// will not hand the camera to a second start() while the first still holds it,
// which is what makes a return visit silently fail to open the viewfinder.
async function stopScanner() {
  if (!scanner) {
    return;
  }
  const current = scanner;
  scanner = null;
  try {
    await current.stop();
    await current.clear();
  } catch (error) {
    // Already torn down, or the camera was revoked underneath us. Either way
    // there is nothing left to release.
  }
  reader.innerHTML = "";
  hide(reader);
  scanButton.disabled = false;
  scanButton.textContent = "Scan QR code";
}

function scannerErrorMessage(error) {
  const message = String((error && error.message) || error || "");
  if (!window.isSecureContext) {
    return "Camera access needs HTTPS. Open this page over https:// or on localhost.";
  }
  if (/NotAllowed|Permission/i.test(message)) {
    return "Camera permission denied. Allow it in your browser settings, or enter the code manually.";
  }
  if (/NotFound|DevicesNotFound/i.test(message)) {
    return "No camera found on this device. Enter the code manually.";
  }
  if (/NotReadable|TrackStart/i.test(message)) {
    return "The camera is busy in another app. Close it and try again.";
  }
  return "Could not start the camera. Enter the code manually.";
}

async function startScanner() {
  setError(lobbyError, "");
  setStatus(scanStatus, "Starting camera...");

  try {
    stopScanner();
    const created = new Html5Qrcode("reader");
    scanner = created;
    show(reader);
    scanButton.disabled = true;
    scanButton.textContent = "Scanning...";

    await created.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      onScanSuccess,
      () => {
        // Fires continuously between real reads. Ignored on purpose.
      }
    );
    setStatus(scanStatus, "Point the camera at the QR code.");
  } catch (error) {
    await stopScanner();
    setStatus(scanStatus, "");
    setError(lobbyError, scannerErrorMessage(error));
  }
}

// One-shot: the camera is released as soon as there is a code, so a re-scan
// always starts from a clean scanner instead of stacking up decoders.
async function onScanSuccess(decodedText) {
  if (!scanner) {
    return;
  }
  setStatus(scanStatus, "Code read.");
  await stopScanner();
  await joinStation(decodedText);
}

// The scanned string may be the bare digits or a full URL that carries them.
// Taking the longest digit run in the string means the printed code works
// whether someone prints the raw token or a link around it.
function extractAccessToken(text) {
  const digits = String(text || "").match(/\d{6,24}/);
  return digits ? digits[0] : "";
}

async function joinStation(rawText) {
  const accessToken = extractAccessToken(rawText);
  if (!accessToken) {
    setError(lobbyError, "That QR code is not a station code.");
    return;
  }

  scanButton.disabled = true;
  setStatus(scanStatus, "Joining station...");

  try {
    const data = await claimStation(accessToken);
    setStatus(scanStatus, "");
    showStation(data.station);
  } catch (error) {
    setStatus(scanStatus, "");
    scanButton.disabled = false;

    if (error.status === 409) {
      // Someone is already there. Named rather than "try again", because
      // "try again" invites a queue at a station that only seats one.
      const who = error.data && error.data.visitor_name
        ? " (" + error.data.visitor_name + " is there)"
        : "";
      setError(lobbyError, "This station is occupied" + who + ". Please wait until they leave.");
      return;
    }
    if (error.status === 404) {
      setError(lobbyError, "That QR code is not a known station.");
      return;
    }
    setError(lobbyError, error.message);
  }
}

// ---------------------------------------------------------------------------
// keep-alive

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStation, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStation() {
  if (!heldStation) {
    return;
  }
  try {
    const data = await myStation();
    if (data.station) {
      return; // still ours
    }
    // Either we never had one or the seat aged out and someone took it. Either
    // way this page is no longer seated, and saying so is better than leaving
    // "You are at RACI" up for someone who has been moved on.
    setStatus(stationState, "Your spot at this station ended. Scan again to rejoin.");
    heldStation = null;
    stopPolling();
    setTimeout(() => showLobby({ name: lobbyName.textContent }), 2500);
  } catch (error) {
    // A dropped poll is not proof the seat is gone. Stay put and try again on
    // the next tick; the server-side stale window is the real backstop.
  }
}

// ---------------------------------------------------------------------------
// events

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError(gateError, "");
  submitButton.disabled = true;
  submitButton.textContent = "Please wait...";

  try {
    const data = await api("/register", {
      method: "POST",
      body: { name: nameInput.value, number: numberInput.value }
    });
    setToken(data.token);
    form.reset();
    showLobby(data.visitor);
  } catch (error) {
    setError(gateError, error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Continue";
  }
});

scanButton.addEventListener("click", startScanner);

manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await stopScanner();
  await joinStation(manualCode.value);
  manualCode.value = "";
});

doneButton.addEventListener("click", async () => {
  if (!heldStation) {
    return;
  }
  const code = heldStation;
  doneButton.disabled = true;

  try {
    await releaseStation(code);
    showLobby({ name: lobbyName.textContent });
  } catch (error) {
    // The seat may already be gone, which is the outcome the button wanted.
    // Falling back to the poll keeps the UI honest instead of showing a
    // station this browser no longer holds.
    setError(lobbyError, error.message);
    showLobby({ name: lobbyName.textContent });
  } finally {
    doneButton.disabled = false;
  }
});

function signOut() {
  // Best effort: give the seat back so the next person is not kept waiting by
  // a browser that has already forgotten who was in it.
  if (heldStation) {
    releaseStation(heldStation).catch(() => {});
  }
  clearToken();
  form.reset();
  setError(gateError, "");
  showGate();
}

document.getElementById("signout").addEventListener("click", signOut);
document.getElementById("signout-2").addEventListener("click", signOut);

// Releases the camera when the tab is hidden, so a user who switches away to
// play the game does not leave a green dot on their camera.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopScanner();
  }
});

window.addEventListener("pagehide", stopScanner);

// ---------------------------------------------------------------------------
// init

(async function init() {
  if (!getToken()) {
    showGate();
    return;
  }

  let visitor;
  try {
    const data = await api("/visitors/me");
    visitor = data.visitor;
  } catch (error) {
    // Expired, tampered with, or the row was deleted server-side.
    clearToken();
    showGate();
    return;
  }

  lobbyName.textContent = visitor.name;

  // Restore the seated view after a refresh, so closing the tab does not look
  // like being thrown out of the station.
  try {
    const data = await myStation();
    if (data.station) {
      showStation(data.station);
      return;
    }
  } catch (error) {
    // Fall through to the lobby; scanning again is harmless.
  }

  showLobby(visitor);
})();
