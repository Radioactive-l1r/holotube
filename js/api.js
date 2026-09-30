// Thin wrapper around fetch, plus the functions that own the session token and
// the station calls.
//
// The token is the single seam for the planned move to real auth. When OTP
// or password login arrives, only token *issuance* changes -- these
// functions, api(), and every /visitors/me call stay exactly as they are.
//
// The station calls are browser-only and deliberately do not carry
// STATION_API_KEY: that key belongs to the Unity/Unreal build, not to public
// client-side JavaScript. Anything shipped to a browser is readable by whoever
// wants it, so the scan flow proves presence with the visitor's own bearer
// token instead.

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
  const allow = response.headers.get("Allow");

  if (!response.ok) {
    const error = new Error(data.error || "Request failed (" + response.status + ")");
    error.status = response.status;
    // Carried onto the error so the UI can react to "someone is already here"
    // without string-matching a human-readable message the server may reword.
    error.data = data;
    error.allow = allow;
    throw error;
  }

  return data;
}

// ---------------------------------------------------------------------------
// stations

// Claim the seat a scanned QR points at. Deliberately sends no station key:
// presence is proven with the visitor's bearer token, and the access_token from
// the QR only says which door they walked through.
function claimStation(accessToken) {
  return api("/stations/claim", {
    method: "POST",
    body: { access_token: accessToken }
  });
}

// Which station this browser holds, if any. Doubles as the keep-alive poll.
function myStation() {
  return api("/stations/me");
}

function releaseStation(stationCode) {
  return api("/stations/" + encodeURIComponent(stationCode) + "/release", {
    method: "POST",
    body: {}
  });
}
