import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("../src/db", () => ({
  kvGet: async (k: string) => store.get(k) ?? null,
  kvSet: async (k: string, v: string) => void store.set(k, v),
}));

import handler from "../netlify/functions/auth-youtube";
import { YouTubePoster } from "../src/platforms/youtube";
import { defaultConfig } from "../src/config";
import { buildAuthUrl, completeSignIn, refreshAccessToken, signState, verifyState } from "../src/youtube-auth";

const ENV = { SITE_URL: "https://example-site.netlify.app", CRON_SECRET: "s3cret", YT_CLIENT_ID: "cid.apps.googleusercontent.com", YT_CLIENT_SECRET: "csecret" };
const KEYS = [...Object.keys(ENV), "YT_REFRESH_TOKEN", "URL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const call = (path: string, init: RequestInit & { auth?: boolean } = {}) =>
  handler(new Request(`https://example-site.netlify.app/api/auth/youtube/${path}`, { ...init, headers: init.auth === false ? {} : { "x-cron-secret": "s3cret" } }));

beforeEach(() => {
  store.clear();
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  vi.unstubAllGlobals();
});

/** Fake Google: token endpoint, channel lookup, revoke. */
function google(opts: { refresh?: string | null; channels?: unknown[]; refreshError?: string } = {}) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), body });
    if (String(url).includes("/token")) {
      if (body.includes("grant_type=refresh_token")) return opts.refreshError ? json({ error: opts.refreshError }, 400) : json({ access_token: "ya29.refreshed" });
      return json({ access_token: "ya29.abc", ...(opts.refresh === null ? {} : { refresh_token: opts.refresh ?? "1//refresh" }) });
    }
    if (String(url).includes("/channels")) return json({ items: opts.channels ?? [{ id: "UC123", snippet: { title: "Python with Isaac", thumbnails: { default: { url: "https://img/x.jpg" } } } }] });
    return json({});
  }));
  return calls;
}

describe("state token", () => {
  it("accepts a fresh token and rejects tampered, expired or foreign ones", () => {
    const t = signState("k", 1_000);
    expect(verifyState("k", t, 2_000)).toBe(true);
    expect(verifyState("other", t, 2_000)).toBe(false);
    expect(verifyState("k", t.replace(/.$/, (c) => (c === "0" ? "1" : "0")), 2_000)).toBe(false);
    expect(verifyState("k", t, 1_000 + 11 * 60_000)).toBe(false);
    expect(verifyState("k", "garbage", 2_000)).toBe(false);
  });
});

describe("consent URL", () => {
  it("asks for offline access, consent, both scopes and our redirect", () => {
    const u = new URL(buildAuthUrl("cid", "https://x/api/auth/youtube/callback", "st"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("redirect_uri")).toBe("https://x/api/auth/youtube/callback");
    expect(u.searchParams.get("scope")).toContain("youtube.upload");
    expect(u.searchParams.get("scope")).toContain("youtube.readonly");
    expect(u.searchParams.get("state")).toBe("st");
  });
});

describe("completing the sign-in", () => {
  it("stores the refresh token and channel details", async () => {
    google();
    const conn = await completeSignIn("code123");
    expect(conn).toMatchObject({ refresh_token: "1//refresh", channel_title: "Python with Isaac", channel_id: "UC123" });
    expect(JSON.parse(store.get("youtube_oauth")!).refresh_token).toBe("1//refresh");
  });
  it("explains a missing refresh token and a missing channel", async () => {
    google({ refresh: null });
    await expect(completeSignIn("c")).rejects.toThrow(/refresh token/);
    google({ channels: [] });
    await expect(completeSignIn("c")).rejects.toThrow(/no YouTube channel/);
  });
  it("turns invalid_grant into a reconnect message", async () => {
    google({ refreshError: "invalid_grant" });
    await expect(refreshAccessToken("old")).rejects.toThrow(/Connect YouTube/);
  });
});

describe("/api/auth/youtube", () => {
  it("needs the access key for url, status and disconnect", async () => {
    for (const [p, m] of [["url", "POST"], ["status", "GET"], ["disconnect", "POST"]] as const) {
      expect((await call(p, { method: m, auth: false })).status).toBe(401);
    }
  });

  it("returns a consent URL carrying a valid signed state", async () => {
    const r = await call("url", { method: "POST" });
    const url = new URL(((await r.json()) as { url: string }).url);
    expect(url.searchParams.get("client_id")).toBe(ENV.YT_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://example-site.netlify.app/api/auth/youtube/callback");
    expect(verifyState("s3cret", url.searchParams.get("state")!)).toBe(true);
  });

  it("callback rejects a bad state without touching Google", async () => {
    const calls = google();
    const r = await call("callback?code=abc&state=forged", { auth: false });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("youtube=error");
    expect(calls).toHaveLength(0);
    expect(store.has("youtube_oauth")).toBe(false);
  });

  it("callback with a valid state connects, then status and disconnect work", async () => {
    const calls = google();
    const state = signState("s3cret");
    const r = await call(`callback?code=abc&state=${state}`, { auth: false });
    expect(r.headers.get("location")).toBe("https://example-site.netlify.app/?youtube=connected");

    const status = (await (await call("status")).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ configured: true, connected: true, source: "dashboard", channelTitle: "Python with Isaac" });
    expect(String(status.redirectUri)).toBe("https://example-site.netlify.app/api/auth/youtube/callback");

    expect((await call("disconnect", { method: "POST" })).status).toBe(200);
    expect(calls.some((c) => c.url.includes("/revoke"))).toBe(true);
    expect(((await (await call("status")).json()) as { connected: boolean }).connected).toBe(false);
  });

  it("callback shows Google's cancel as a friendly message", async () => {
    const r = await call("callback?error=access_denied", { auth: false });
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("Sign-in was cancelled.");
  });
});

describe("posting uses the dashboard connection", () => {
  it("refreshes with the stored token, falls back to the env token, or explains", async () => {
    const calls = google();
    store.set("youtube_oauth", JSON.stringify({ refresh_token: "1//stored", channel_id: "UC", channel_title: "T", thumbnail: "", connected_at: "x" }));
    await YouTubePoster.create(defaultConfig);
    expect(calls.at(-1)!.body).toContain("refresh_token=1%2F%2Fstored");

    store.clear();
    process.env.YT_REFRESH_TOKEN = "1//fromenv";
    await YouTubePoster.create(defaultConfig);
    expect(calls.at(-1)!.body).toContain("refresh_token=1%2F%2Ffromenv");

    delete process.env.YT_REFRESH_TOKEN;
    await expect(YouTubePoster.create(defaultConfig)).rejects.toThrow(/Connect YouTube/);
  });
});
