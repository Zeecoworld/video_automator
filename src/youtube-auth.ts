import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db";
import { opt, req } from "./env";

/** upload = post videos; readonly = read the channel name/avatar so the dashboard can show who is connected. */
export const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const KV_KEY = "youtube_oauth";
const STATE_TTL_MS = 10 * 60_000;

export interface YtConnection {
  refresh_token: string;
  channel_id: string;
  channel_title: string;
  thumbnail: string;
  connected_at: string;
}

export function siteUrl(): string {
  const s = opt("SITE_URL") ?? opt("URL");
  if (!s) throw new Error("Set SITE_URL to your Netlify site URL (for example https://yoursite.netlify.app)");
  return s.replace(/\/$/, "");
}

/** Must be added, exactly, under "Authorized redirect URIs" on your Google OAuth *Web application* client. */
export const redirectUri = () => `${siteUrl()}/api/auth/youtube/callback`;

// ---------------------------------------------------------------- state (anti-CSRF)

const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex").slice(0, 32);

/** Short-lived signed token. Only someone who passed the access-key check can start a flow, and the callback proves it. */
export function signState(secret: string, nowMs = Date.now(), nonce = randomBytes(8).toString("hex")): string {
  const body = `${nowMs + STATE_TTL_MS}.${nonce}`;
  return `${body}.${mac(secret, body)}`;
}

export function verifyState(secret: string, state: string, nowMs = Date.now()): boolean {
  const parts = state.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) < nowMs) return false;
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(mac(secret, `${parts[0]}.${parts[1]}`));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildAuthUrl(clientId: string, redirect: string, state: string): string {
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: YT_SCOPES.join(" "),
      access_type: "offline", // gives us a refresh token
      prompt: "consent", // and makes Google return it every time
      include_granted_scopes: "true",
      state,
    })
  );
}

// ---------------------------------------------------------------- Google calls

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenCall(params: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: req("YT_CLIENT_ID"), client_secret: req("YT_CLIENT_SECRET"), ...params }),
  });
  return (await r.json().catch(() => ({}))) as TokenResponse;
}

export async function exchangeCode(code: string, redirect: string): Promise<{ accessToken: string; refreshToken: string }> {
  const j = await tokenCall({ code, redirect_uri: redirect, grant_type: "authorization_code" });
  if (!j.access_token) throw new Error(`Google refused the sign-in: ${j.error_description ?? j.error ?? "unknown error"}`);
  if (!j.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove this app at myaccount.google.com/permissions, then connect again.");
  }
  return { accessToken: j.access_token, refreshToken: j.refresh_token };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const j = await tokenCall({ refresh_token: refreshToken, grant_type: "refresh_token" });
  if (!j.access_token) {
    if (j.error === "invalid_grant") throw new Error("The YouTube connection expired or was revoked. Press Connect YouTube on the dashboard to sign in again.");
    throw new Error(`YouTube token refresh failed: ${j.error_description ?? j.error ?? "unknown error"}`);
  }
  return j.access_token;
}

export async function fetchChannel(accessToken: string): Promise<{ id: string; title: string; thumbnail: string }> {
  const r = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = (await r.json().catch(() => ({}))) as {
    items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[];
    error?: { message?: string };
  };
  const ch = j.items?.[0];
  if (!ch) {
    throw new Error(
      j.error?.message
        ? `Could not read your YouTube channel: ${j.error.message}`
        : "This Google account has no YouTube channel. Create one at youtube.com, then connect again.",
    );
  }
  return { id: ch.id, title: ch.snippet.title, thumbnail: ch.snippet.thumbnails?.default?.url ?? "" };
}

export async function revoke(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------- storage (Supabase kv, service role only)

export async function loadConnection(): Promise<YtConnection | null> {
  const v = await db.kvGet(KV_KEY);
  if (!v) return null;
  try {
    const j = JSON.parse(v) as YtConnection;
    return j?.refresh_token ? j : null;
  } catch {
    return null;
  }
}

export const saveConnection = (c: YtConnection) => db.kvSet(KV_KEY, JSON.stringify(c));
export const clearConnection = () => db.kvSet(KV_KEY, "");

/** Finish the flow: code -> tokens -> channel -> stored. */
export async function completeSignIn(code: string): Promise<YtConnection> {
  const { accessToken, refreshToken } = await exchangeCode(code, redirectUri());
  const ch = await fetchChannel(accessToken);
  const conn: YtConnection = {
    refresh_token: refreshToken, channel_id: ch.id, channel_title: ch.title, thumbnail: ch.thumbnail, connected_at: new Date().toISOString(),
  };
  await saveConnection(conn);
  return conn;
}
