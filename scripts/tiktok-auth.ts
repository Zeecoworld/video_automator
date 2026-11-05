/**
 * One-time: get a TikTok refresh token.
 * Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI (must exactly match a redirect URI registered in your
 * TikTok developer app, with Login Kit and Content Posting API added). Then run:  npm run auth:tiktok
 * Open the printed URL, approve, and paste the full URL you were redirected to (the page may show an error; that's fine).
 */
import { randomBytes } from "node:crypto";
import readline from "node:readline/promises";

const key = process.env.TIKTOK_CLIENT_KEY;
const secret = process.env.TIKTOK_CLIENT_SECRET;
const redirect = process.env.TIKTOK_REDIRECT_URI;
if (!key || !secret || !redirect) {
  console.error("Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI first.");
  process.exit(1);
}
const state = randomBytes(8).toString("hex");
console.log(
  "Open this URL in your browser:\n\n" +
    "https://www.tiktok.com/v2/auth/authorize/?" +
    new URLSearchParams({ client_key: key, scope: "user.info.basic,video.upload,video.publish", response_type: "code", redirect_uri: redirect, state }) +
    "\n",
);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cb = new URL((await rl.question("Paste the full redirected URL: ")).trim());
rl.close();
if (cb.searchParams.get("state") !== state) { console.error("State mismatch, aborting."); process.exit(1); }
const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_key: key, client_secret: secret, code: cb.searchParams.get("code") ?? "",
    grant_type: "authorization_code", redirect_uri: redirect,
  }),
});
const j = (await r.json()) as { refresh_token?: string };
console.log(j.refresh_token ? `\nTIKTOK_REFRESH_TOKEN=${j.refresh_token}` : `Token exchange failed: ${JSON.stringify(j)}`);
