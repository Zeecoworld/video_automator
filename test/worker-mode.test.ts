import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFetchError, launchWorker, startWorker, workerMode } from "../src/github";

const KEYS = ["WORKER_MODE", "MODAL_WORKER_URL", "COBALT_API_URL", "CRON_SECRET", "SITE_URL", "URL", "GH_DISPATCH_TOKEN", "GH_REPO"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  vi.unstubAllGlobals();
});

describe("worker mode", () => {
  it("defaults to the local polling worker, with Cobalt/Modal/GitHub only when configured", async () => {
    for (const k of KEYS) delete process.env[k];
    expect(workerMode()).toBe("local");
    process.env.COBALT_API_URL = "https://cobalt.example/";
    expect(workerMode()).toBe("netlify");
    process.env.MODAL_WORKER_URL = "https://x--clip-engine-start.modal.run";
    expect(workerMode()).toBe("modal");
    process.env.WORKER_MODE = "github";
    expect(workerMode()).toBe("github");
    delete process.env.WORKER_MODE; delete process.env.MODAL_WORKER_URL; delete process.env.COBALT_API_URL;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await startWorker();
    expect(r.dispatched).toBe(true);
    expect(r.note).toMatch(/within a minute/);
    expect(f).not.toHaveBeenCalled(); // local mode needs no URL: the worker polls the queue
  });

  it("launchWorker calls Modal with the shared secret", async () => {
    process.env.MODAL_WORKER_URL = "https://x--clip-engine-start.modal.run";
    process.env.CRON_SECRET = "s3cret";
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await launchWorker()).toEqual({ dispatched: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x--clip-engine-start.modal.run");
    expect(init).toMatchObject({ method: "POST", headers: { "x-cron-secret": "s3cret" } });
  });

  it("startWorker never waits on Modal: it only calls the background function", async () => {
    process.env.MODAL_WORKER_URL = "https://x--clip-engine-start.modal.run";
    process.env.CRON_SECRET = "s3cret";
    process.env.SITE_URL = "https://site.netlify.app";
    const f = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", f);
    expect(await startWorker()).toEqual({ dispatched: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("https://site.netlify.app/.netlify/functions/start-worker-background");
  });

  it("launchWorker reports a failed start instead of throwing", async () => {
    process.env.MODAL_WORKER_URL = "https://x--clip-engine-start.modal.run";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    const r = await launchWorker();
    expect(r.dispatched).toBe(false);
    expect(r.note).toMatch(/401/);
  });

  it("names the host and the reason when a fetch fails", async () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(describeFetchError(e, "https://nope.modal.run/x")).toBe("fetch failed | ENOTFOUND | while calling nope.modal.run");
    process.env.MODAL_WORKER_URL = "https://nope.modal.run";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(e));
    expect((await launchWorker()).note).toMatch(/ENOTFOUND.*nope\.modal\.run/);
  });
});
