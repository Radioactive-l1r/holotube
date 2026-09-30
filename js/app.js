// Screen flow: gate (name + number) <-> app (welcome).
//
// On load, a token in localStorage is exchanged for the visitor's record.
// The welcome name comes from the server's stored value, not from whatever
// was typed, so the two can never disagree.

const gate = document.getElementById("gate");
const app = document.getElementById("app");
const form = document.getElementById("register-form");
const nameInput = document.getElementById("name");
const numberInput = document.getElementById("number");
const submitButton = document.getElementById("submit");
const errorBox = document.getElementById("gate-error");
const username = document.getElementById("username");

function show(el) {
  el.hidden = false;
}

function hide(el) {
  el.hidden = true;
}

function showGate() {
  hide(app);
  show(gate);
}

function showApp(visitor) {
  username.textContent = visitor.name;
  hide(gate);
  show(app);
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.textContent = busy ? "Please wait..." : "Continue";
}

function showError(message) {
  errorBox.textContent = message;
  show(errorBox);
}

function clearError() {
  errorBox.textContent = "";
  hide(errorBox);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  setBusy(true);

  try {
    const data = await api("/register", {
      method: "POST",
      body: { name: nameInput.value, number: numberInput.value }
    });

    setToken(data.token);
    form.reset();
    showApp(data.visitor);
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});

document.getElementById("signout").addEventListener("click", () => {
  clearToken();
  form.reset();
  clearError();
  showGate();
});

(async function init() {
  if (!getToken()) {
    showGate();
    return;
  }

  try {
    const data = await api("/visitors/me");
    showApp(data.visitor);
  } catch (error) {
    // Expired, tampered with, or the row was deleted server-side.
    clearToken();
    showGate();
  }
})();
