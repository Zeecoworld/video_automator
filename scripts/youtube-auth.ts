/**
 * One-time: get a YouTube refresh token.
 * 1. Google Cloud Console: create a project, enable "YouTube Data API v3".
 * 2. OAuth consent screen: set Publishing status to "In production" (in Testing the refresh token expires after 7 days).
 * 3. Credentials -> Create OAuth client ID -> "Desktop app". Copy the client ID and secret.
 * 4. Run:  YT_CLIENT_ID=... YT_CLIENT_SECRET=... npm run auth:youtube
 */
import http from "node:http";

const id = process.env.YT_CLIENT_ID;
const secret = process.env.YT_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Set YT_CLIENT_ID and YT_CLIENT_SECRET first.");
  process.exit(1);
}
const port = 53682;
const redirect = `http://127.0.0.1:${port}/callback`;
const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: id, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent",
    scope: "https://www.googleapis.com/auth/youtube.upload",
  });
console.log("Open this URL in your browser:\n\n" + url + "\n");

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "", redirect).searchParams.get("code");
  if (!code) { res.end("Waiting for authorisation..."); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const j = (await r.json()) as { refresh_token?: string };
  res.end("Done. You can close this tab.");
  console.log(j.refresh_token ? `YT_REFRESH_TOKEN=${j.refresh_token}` : `No refresh token returned: ${JSON.stringify(j)}`);
  server.close();
});
server.listen(port);
