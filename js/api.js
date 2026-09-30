// Thin wrapper around fetch, plus the three functions that own the session
// token.
//
// The token is the single seam for the planned move to real auth. When OTP
// or password login arrives, only token *issuance* changes -- these
// functions, api(), and every /visitors/me call stay exactly as they are.

const TOKEN_KEY = "holotube.visitor_token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options) {
  const opts = Object.assign({ method: "GET" }, options || {});
  opts.headers = Object.assign({}, opts.headers);

  if (opts.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }

  const token = getToken();
  if (token) {
    opts.headers["Authorization"] = "Bearer " + token;
  }

  const response = await fetch(API_URL + path, opts);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || "Request failed (" + response.status + ")");
    error.status = response.status;
    throw error;
  }

  return data;
}
