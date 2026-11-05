// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const body = html.match(/<body>([\s\S]*)<script>/)![1];
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

const NOW = new Date("2026-11-02T13:00:00Z").getTime();
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

const queue = {
  now: at(0),
  stats: {},
  sources: [
    { id: "s1", platform: "youtube", url: "https://youtu.be/aaa", title: "Top Languages", status: "processing", error: null, rendered: 2, planned: 4, variants: ["pad"], created_at: at(-20) },
    { id: "s2", platform: "youtube", url: "https://youtu.be/bad", title: null, status: "failed", error: "YouTube blocked this server as a bot.", rendered: 0, planned: 0, variants: ["pad"], created_at: at(-60) },
    { id: "s3", platform: "tiktok", url: "https://youtu.be/new", title: null, status: "pending", error: null, rendered: 0, planned: 0, variants: ["pad"], created_at: at(-30) },
  ],
  clips: [
    { id: "c1", platform: "youtube", variant: "pad", title: "Why Python wins", headline: "Python wins", status: "ready", scheduled_at: at(135), posted_at: null, platform_post_id: null, error: null, storage_url: "https://res.cloudinary.com/x/video/upload/c1.mp4" },
    { id: "c2", platform: "youtube", variant: "fill", title: "Already due", headline: "", status: "ready", scheduled_at: at(-5), posted_at: null, platform_post_id: null, error: null, storage_url: "" },
    { id: "c3", platform: "youtube", variant: "pad", title: "Live one", headline: "", status: "posted", scheduled_at: at(-300), posted_at: at(-290), platform_post_id: "abc123", error: null, storage_url: null },
    { id: "c4", platform: "tiktok", variant: "pad", title: "Broke", headline: "", status: "failed", scheduled_at: at(-90), posted_at: null, platform_post_id: null, error: "Could not connect to tiktok: Missing required environment variable TIKTOK_CLIENT_KEY", storage_url: "" },
  ],
};

let ytStatus: Record<string, unknown> = { configured: true, connected: true, source: "dashboard", channelTitle: "My Channel", thumbnail: "", connectedAt: "2026-11-01T10:00:00Z", redirectUri: "https://site/api/auth/youtube/callback" };
let authCfg: Record<string, unknown> = { enabled: false };
const flush = async () => { await vi.advanceTimersByTimeAsync(20); await vi.advanceTimersByTimeAsync(20); };
const listeners: [string, EventListener][] = [];
const calls: { url: string; body?: any; headers?: Record<string, string> }[] = [];

beforeEach(async () => {
  authCfg = { enabled: false };
  localStorage.clear();
  history.replaceState(null, "", "/");
  ytStatus = { configured: true, connected: true, source: "dashboard", channelTitle: "My Channel", thumbnail: "", connectedAt: "2026-11-01T10:00:00Z", redirectUri: "https://site/api/auth/youtube/callback" };
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  calls.length = 0;
  document.body.innerHTML = body;
  if (!(globalThis as any).__skipDefaultKey) localStorage.setItem("clip-key", "secret");
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> } as never);
    const payload = url === "/api/auth/config" ? authCfg
      : url === "/api/queue" ? queue
      : url === "/api/auth/youtube/status" ? ytStatus
      : url === "/api/auth/youtube/url" ? { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }
      : { ok: true, queued: 1, platforms: ["youtube"], workerStarted: true };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as never;
  // The page registers one document-level click handler; keep tests isolated by removing it after each test.
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(((type: string, fn: EventListener, opts?: unknown) => {
    listeners.push([type, fn]);
    add(type, fn, opts as never);
  }) as never);
  new Function(script)();
  await flush();
});

afterEach(() => {
  for (const [t, f] of listeners.splice(0)) document.removeEventListener(t, f);
  vi.restoreAllMocks();
  vi.clearAllTimers();
});

describe("dashboard", () => {
  it("shows link progress in plain words", () => {
    const t = document.getElementById("sources")!.textContent!;
    expect(t).toContain("Cutting clips 2 of 4");
    expect(t).toContain("YouTube blocked this server as a bot.");
    expect(t).toContain("Waiting for the worker");
    expect(document.querySelector('[data-act="retry-link"]')).not.toBeNull();
  });

  it("shows the next post with a live countdown and the check time", () => {
    const tiles = document.getElementById("tiles")!.textContent!;
    expect(tiles).toContain("Next post");
    expect(tiles).toContain("YouTube");
    const cd = document.querySelector("#clip-c1 .cd") as HTMLElement;
    expect(cd.textContent).toBe("in 2h 15m");
    vi.advanceTimersByTime(61_000);
    expect(cd.textContent).toBe("in 2h 13m");
    expect(document.getElementById("clip-c1")!.textContent).toMatch(/Goes live around/);
    expect(document.getElementById("checkNote")!.textContent).toMatch(/Next check at/);
  });

  it("marks overdue clips as due and lists only upcoming ones by default", () => {
    expect(document.getElementById("clip-c2")!.textContent).toContain("Due");
    expect(document.getElementById("clip-c3")).toBeNull();
    expect(document.getElementById("clip-c4")).toBeNull();
  });

  it("filters posted and failed, with a YouTube link and the failure reason", () => {
    (document.querySelector('.tab[data-f="posted"]') as HTMLElement).click();
    const a = document.querySelector("#clip-c3 a") as HTMLAnchorElement;
    expect(a.href).toBe("https://www.youtube.com/watch?v=abc123");
    (document.querySelector('.tab[data-f="failed"]') as HTMLElement).click();
    expect(document.getElementById("clip-c4")!.textContent).toContain("TIKTOK_CLIENT_KEY");
  });

  it("post now, reschedule and remove call the clip API", async () => {
    (document.querySelector('#clip-c1 [data-act="post-now"]') as HTMLElement).click();
    await flush();
    expect(calls.find((c) => c.url === "/api/clip")?.body).toMatchObject({ id: "c1", action: "post-now" });

    (document.querySelector('#clip-c1 [data-act="resched"]') as HTMLElement).click();
    const input = document.getElementById("dt-c1") as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "2026-11-03T09:30";
    (document.querySelector('[data-act="save-resched"]') as HTMLElement).click();
    await flush();
    const r = calls.filter((c) => c.url === "/api/clip").pop()!.body;
    expect(r).toMatchObject({ id: "c1", action: "reschedule" });
    expect(new Date(r.at).getTime()).toBe(new Date("2026-11-03T09:30").getTime());

    vi.stubGlobal("confirm", () => true);
    (document.querySelector('#clip-c1 [data-act="cancel"]') as HTMLElement).click();
    await flush();
    expect(calls.filter((c) => c.url === "/api/clip").pop()!.body).toMatchObject({ id: "c1", action: "cancel" });
  });

  it("previews a clip on demand", () => {
    (document.querySelector('#clip-c1 [data-act="preview"]') as HTMLElement).click();
    expect((document.querySelector("#slot-c1 video") as HTMLVideoElement).src).toContain("c1.mp4");
  });

  it("adding links sends platforms and the chosen style count", async () => {
    (document.getElementById("links") as HTMLTextAreaElement).value = "https://youtu.be/xyz";
    (document.getElementById("variations") as HTMLSelectElement).value = "2";
    (document.getElementById("go") as HTMLElement).click();
    await flush();
    expect(calls.find((c) => c.url === "/api/ingest")?.body).toMatchObject({ platforms: ["youtube"], variations: 2 });
    expect(document.getElementById("msg")!.textContent).toContain("Worker started.");
  });

  it("shows the connected YouTube channel and can disconnect it", async () => {
    expect(document.getElementById("yt")!.textContent).toContain("YouTube connected");
    expect(document.getElementById("yt")!.textContent).toContain("My Channel");
    vi.stubGlobal("confirm", () => true);
    (document.querySelector('[data-act="yt-disconnect"]') as HTMLElement).click();
    await flush();
    expect(calls.some((c) => c.url === "/api/auth/youtube/disconnect")).toBe(true);
  });

  it("offers Connect YouTube when signed out, and asks Google for the consent URL", async () => {
    ytStatus = { configured: true, connected: false, source: null };
    document.getElementById("refresh")!.click();
    await flush();
    const btn = document.querySelector('[data-act="yt-connect"]') as HTMLElement;
    expect(btn.textContent).toBe("Connect YouTube");
    vi.spyOn(console, "error").mockImplementation(() => undefined); // jsdom cannot navigate
    btn.click();
    await flush();
    expect(calls.some((c) => c.url === "/api/auth/youtube/url" && c.body !== undefined)).toBe(true);
  });

  it("tells you what to set up when the Google client is missing", async () => {
    ytStatus = { configured: false, connected: false, source: null, redirectUri: "https://site/api/auth/youtube/callback" };
    document.getElementById("refresh")!.click();
    await flush();
    const t = document.getElementById("yt")!.textContent!;
    expect(t).toContain("YT_CLIENT_ID");
    expect(t).toContain("https://site/api/auth/youtube/callback");
  });
});

describe("email sign-in", () => {
  async function boot(cfg: Record<string, unknown>, setup?: () => void) {
    for (const [t, f] of listeners.splice(0)) document.removeEventListener(t, f);
    authCfg = cfg;
    calls.length = 0;
    document.body.innerHTML = body;
    setup?.();
    new Function(script)();
    await flush();
  }

  it("is hidden unless the server enables it", () => {
    expect((document.getElementById("email") as HTMLElement).style.display).toBe("none");
    expect((document.getElementById("signin") as HTMLElement).style.display).toBe("none");
  });

  it("offers an email link and asks Supabase to send it", async () => {
    await boot({ enabled: true, supabaseUrl: "https://proj.supabase.co", anonKey: "anon" });
    expect((document.getElementById("signin") as HTMLElement).style.display).toBe("");
    (document.getElementById("email") as HTMLInputElement).value = "me@example.com";
    (document.getElementById("signin") as HTMLElement).click();
    await flush();
    const c = calls.find((x) => x.url.startsWith("https://proj.supabase.co/auth/v1/otp"))!;
    expect(c.body).toEqual({ email: "me@example.com", create_user: true });
    expect(c.headers!.apikey).toBe("anon");
    expect(decodeURIComponent(c.url)).toContain("redirect_to=");
  });

  it("uses the session token instead of the access key once signed in", async () => {
    await boot({ enabled: true, supabaseUrl: "https://proj.supabase.co", anonKey: "anon" }, () => {
      localStorage.removeItem("clip-key");
      localStorage.setItem("clip-session", JSON.stringify({ access: "sess-token", refresh: "r", exp: Date.now() + 3_600_000 }));
    });
    const q = calls.find((x) => x.url === "/api/queue")!;
    expect(q.headers!.Authorization).toBe("Bearer sess-token");
    expect(q.headers!["x-cron-secret"]).toBeUndefined();
    expect((document.getElementById("signout") as HTMLElement).style.display).toBe("");
  });

  it("stores the session from the magic-link redirect and cleans the address", async () => {
    await boot({ enabled: true, supabaseUrl: "https://proj.supabase.co", anonKey: "anon" }, () => {
      localStorage.removeItem("clip-key");
      history.replaceState(null, "", "/#access_token=abc&refresh_token=def&expires_in=3600&token_type=bearer");
    });
    expect(JSON.parse(localStorage.getItem("clip-session")!).access).toBe("abc");
    expect(location.hash).toBe("");
    expect(calls.find((x) => x.url === "/api/queue")!.headers!.Authorization).toBe("Bearer abc");
  });
});
