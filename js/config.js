// Front-end configuration. This is the only file to edit when you deploy.
//
// 1. AWS Console > Lambda > your function > Function URL
// 2. Replace the placeholder below with that URL. It looks like:
//      https://abcdefghij.lambda-url.us-east-1.on.aws
//
// There are deliberately no secrets in this file. The browser cannot hold
// one -- anything shipped to the browser is readable by whoever opens dev
// tools, so auth is enforced server-side in lambda_function.py instead.
//
// Testing locally: opening index.html directly (file://) will fail with a
// CORS error, because the browser sends an "Origin: null" that the
// Function URL's CORS allow-list will not match. Serve it over HTTP instead:
//     python -m http.server 8000 --directory web
// then open http://localhost:8000

const API_URL = "https://3wnjs7zlcveuthesh2fcnax4sm0lntav.lambda-url.us-east-1.on.aws";
