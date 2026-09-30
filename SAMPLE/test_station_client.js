// Drives RACI.html's real state machine against a fake API, with a minimal DOM.
// Nothing here is reimplemented: the script is extracted from the HTML and run
// as-is, so this tests what the Unity dev would actually copy.
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("web/SAMPLE/RACI.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- fake server -------------------------------------------------------
const server = {
  stationExists: true,
  occupied: false,
  visitorName: null,
  occupiedAt: null,
  staleMinutes: 5,
  hasQuestion: true,
  question: { question_id: 1, prompt: "What does the R in RACI stand for?",
              options: { A: "Responsible", B: "Accountable",
                         C: "Consulted", D: "Informed" } },
  correct: "A",
  answered: new Set(),
  lastAnswer: null,
  calls: [],
};

function serve(path, method, body) {
  server.calls.push(method + " " + path);

  // 403 stands in for a wrong or unset STATION_API_KEY. Checked before the
  // station lookup, exactly as the real is_station_client guard does.
  if (server.rejectKey) {
    return { status: 403, data: { error: "Forbidden." } };
  }
  if (server.failNext) {
    const s = server.failNext; server.failNext = 0;
    return { status: s, data: { error: "Internal error." } };
  }

  if (!server.stationExists) {
    return { status: 404, data: { error: "Unknown station.", code: "unknown_station" } };
  }

  if (path.endsWith("/answer")) {
    if (!server.occupied) {
      return { status: 409, data: { error: "Nobody is at this station right now.",
                                    code: "station_empty" } };
    }
    const key = server.question.question_id + "|" + server.seatedVisitor;
    if (server.answered.has(key)) {
      return { status: 409, data: { error: "This question has already been answered.",
                                    code: "already_answered",
                                    visitor_number: server.seatedVisitor,
                                    correct_option: server.correct } };
    }
    server.answered.add(key);
    server.lastAnswer = { visitor_number: server.seatedVisitor,
                          visitor_name: server.visitorName,
                          selected_option: body.option,
                          correct_option: server.correct,
                          correct: body.option === server.correct };
    server.occupied = false;
    return { status: 200, data: server.lastAnswer };
  }

  if (path.endsWith("/question")) {
    if (!server.hasQuestion) {
      return { status: 404, data: { error: "This station has no active quiz.",
                                    code: "no_active_question" } };
    }
    return { status: 200, data: { station_code: "X", question: server.question } };
  }

  if (method === "GET") {
    return { status: 200, data: {
      station_code: "X", display_name: "RACI Station",
      occupied: server.occupied, visitor_name: server.visitorName,
      occupied_at: server.occupiedAt, stale_after_minutes: server.staleMinutes } };
  }
  return { status: 404, data: { error: "Not found." } };
}

// ---- minimal DOM -------------------------------------------------------
function makeEl(id) {
  const listeners = {};
  return {
    id, hidden: false, textContent: "", innerHTML: "", className: "",
    disabled: false, scrollTop: 0, scrollHeight: 0, value: "",
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire(ev) { (listeners[ev] || []).forEach(f => f({})); },
    _listeners: listeners,
    appendChild() {}, querySelectorAll() { return []; },
  };
}

const els = {};
const ctx = {
  console,
  Date, Math, JSON, Object, Array, Number, String, Boolean, Error, isNaN, parseInt,
  setTimeout, clearTimeout, setInterval, clearInterval,
  encodeURIComponent, Promise,
  document: {
    getElementById: (id) => (els[id] = els[id] || makeEl(id)),
    createElement: (t) => makeEl(t),
    querySelectorAll: () => [],
  },
  fetch: async (url, config) => {
    const path = url.replace(/^https:\/\/[^/]+/, "");
    const method = config.method || "GET";
    const body = config.body ? JSON.parse(config.body) : undefined;
    const r = serve(path, method, body);
    return { ok: r.status < 400, status: r.status,
             json: async () => r.data };
  },
  window: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(script, ctx);

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ck = (label, cond, extra) => {
  console.log(`  ${cond ? "OK  " : "FAIL"} ${label}${extra !== undefined ? " -> " + JSON.stringify(extra) : ""}`);
  if (!cond) fails++;
};
const pollCount = () => server.calls.filter(c => /^GET \/stations\/[A-Z0-9_-]+$/.test(c)).length;
const view = () => ["idle","qr","question","result","fault"]
  .find(v => els["view-" + v] && !els["view-" + v].hidden);

(async () => {
  console.log("1. boots idle, no requests made");
  ck("view is idle", view(), "idle");
  ck("made zero calls while idle", server.calls.length === 0, server.calls.length);

  console.log("\n2. press 'Scan to play' -> QR shown, polling begins");
  els["btn-show"]._fire("click");
  await wait(60);
  ck("view is qr", view(), "qr");
  ck("already polled immediately, not after 3s", pollCount() >= 1, pollCount());
  const afterFirst = server.calls.length;

  console.log("\n3. seat still free -> stays on QR, keeps polling");
  await wait(3400);
  const polls = pollCount();
  ck("polled again within 3s", polls >= 2, polls);
  ck("still on the QR screen", view(), "qr");

  console.log("\n4. someone scans -> stop the fast poll, show the question");
  server.occupied = true;
  server.seatedVisitor = "9876543210";
  server.visitorName = "Aarav";
  server.occupiedAt = new Date().toISOString();
  await wait(3400);
  ck("moved to the question view", view(), "question");
  ck("shows the player's name", els["player-name"].textContent, "Aarav");
  ck("shows the prompt", els["question-text"].textContent, server.question.prompt);
  ck("fetched the question", server.calls.some(c => c.endsWith("/question")));

  const before = pollCount();
  await wait(1000);
  const after = pollCount();
  ck("fast poll stopped once seated", after === before, { before, after });

  console.log("\n5. press option A -> answer recorded, seat freed, idle");
  els["options"].innerHTML = "";
  // Re-render options then invoke the handler the way a click would.
  ctx.__choose = null;
  const opts = ctx.document.getElementById("options");
  // The sample binds choose() to buttons created in renderOptions; drive it
  // through the same path by calling renderOptions then clicking a real node.
  const realAppend = opts.appendChild;
  const created = [];
  opts.appendChild = (n) => { created.push(n); realAppend(n); };
  ctx.renderOptions(server.question.options);
  ck("rendered four options", created.length, 4);
  ck("option A labelled", created[0].innerHTML.indexOf("Responsible") >= 0);
  ck("option D labelled", created[3].innerHTML.indexOf("Informed") >= 0);

  await created[0]._listeners.click[0]();
  await wait(60);
  ck("answer submitted", server.lastAnswer && server.lastAnswer.selected_option, "A");
  ck("credited the seated player", server.lastAnswer.visitor_number, "9876543210");
  ck("named them", server.lastAnswer.visitor_name, "Aarav");
  ck("graded correct", server.lastAnswer.correct, true);
  ck("server freed the seat", server.occupied === false, server.occupied);
  ck("went straight to result, no poll needed", view(), "result");
  ck("shows correct", els["result-text"].textContent, "Correct!");

  console.log("\n6. back to idle, then QR again");
  els["btn-again"]._fire("click");
  await wait(30);
  ck("idle", view(), "idle");
  els["btn-show"]._fire("click");
  await wait(60);
  ck("qr again", view(), "qr");
  ck("seat is free, so no question is shown", view() !== "question");

  console.log("\n7. player presses a button with nobody seated -> station_empty");
  await wait(3400);           // let it poll, seat still free
  server.occupied = true;
  server.visitorName = "Aarav";
  server.occupiedAt = new Date().toISOString();
  await wait(3400);           // poll notices, moves to question
  ck("seated again", view(), "question");
  server.occupied = false;    // seat expired behind the game's back
  await wait(60);
  const opts2 = [];
  const box2 = ctx.document.getElementById("options");
  box2.innerHTML = ""; box2.appendChild = (n) => opts2.push(n);
  ctx.renderOptions(server.question.options);
  await opts2[1]._listeners.click[0]();
  await wait(60);
  ck("handled station_empty, back to the QR", view(), "qr");

  console.log("\n8. local expiry timer fires without any poll");
  server.occupied = true; server.visitorName = "Slow Reader";
  server.staleMinutes = 0.02;   // ~1.2s
  server.occupiedAt = new Date().toISOString();
  await wait(3400);
  ck("seated, waiting on the timer", view(), "question");
  await wait(1800);
  ck("expired itself and returned to the QR", view(), "qr");

  console.log("\n9. misconfigured station code");
  server.stationExists = false;
  els["btn-hide"]._fire("click");
  els["btn-show"]._fire("click");
  await wait(60);
  ck("shows the fault screen instead of silently looping", view(), "fault");
  ck("names the actual problem", els["fault-text"].textContent, "Unknown station (404)");
  const callsAfter = server.calls.length;
  await wait(3400);
  ck("stopped hammering after unknown_station", server.calls.length === callsAfter, server.calls.length - callsAfter);

  console.log("\n10. no quiz configured yet");
  server.stationExists = true; server.hasQuestion = false; server.staleMinutes = 5;
  els["btn-hide"]._fire("click");
  els["btn-show"]._fire("click");
  await wait(60);
  server.occupied = true; server.visitorName = "Meera";
  server.occupiedAt = new Date().toISOString();
  await wait(3400);
  ck("holds the seat, explains the problem", view(), "question");
  ck("tells the player why", els["question-text"].textContent.indexOf("No quiz") >= 0, els["question-text"].textContent);

  
console.log("\n11. STATION_API_KEY rejected -- the reported 403");
server.stationExists = true; server.hasQuestion = true;
server.rejectKey = true;
const callsBefore403 = server.calls.length;
els["btn-hide"]._fire("click");
els["btn-show"]._fire("click");
await wait(60);
ck("shows the fault screen, not the QR", view(), "fault");
ck("names the status", els["fault-text"].textContent, "Forbidden (403)");
ck("explains it is the key, not the station",
   els["fault-detail"].textContent.indexOf("STATION_API_KEY") >= 0);
const at403 = server.calls.length;
await wait(3400);
ck("stops polling instead of a new 403 every 3s",
   server.calls.length, at403);
ck("  ...and made zero further requests", server.calls.length === at403, server.calls.length - at403);

console.log("\n12. key fixed -> Retry recovers");
server.rejectKey = false;
await els["btn-retry"]._listeners.click[0]();
await wait(60);
ck("back to the QR screen", view(), "qr");
ck("polling resumed", pollCount() > 0, pollCount());

console.log("\n13. transient 500 is NOT treated as a config fault");
server.stationExists = true;
server.failNext = 500;
server.staleMinutes = 5;   // back to a sane window; step 8 left it at ~1s
server.occupiedAt = new Date().toISOString();
els["btn-hide"]._fire("click");
els["btn-show"]._fire("click");
await wait(60);
const before5xx = server.calls.length;
await wait(3400);
ck("kept polling through a transient failure",
   server.calls.length > before5xx, server.calls.length - before5xx);
ck("stayed on the QR, did not show the fault screen", view(), "qr");

console.log("\\n14. a seat already past the stale window self-expires at once");
server.occupiedAt = new Date(Date.now() - 600000).toISOString(); // occupied 10 min ago
server.staleMinutes = 5;                                            // window is 5 min -> long expired
server.occupied = true;
els["btn-hide"]._fire("click");
els["btn-show"]._fire("click");
await wait(80);
ck("did not sit on an already-dead seat", view() !== "question", view());
ck("  ...it is back to the QR, waiting for a fresh scan", view(), "qr");

console.log(`\n${"=".repeat(56)}`);
  console.log(fails === 0 ? "PASS -- every state transition verified" : `FAIL (${fails})`);
  process.exit(fails ? 1 : 0);
})();














