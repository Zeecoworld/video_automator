import { opt } from "./env";
import { trigger } from "./http";

/** Start the worker workflow right away (otherwise it picks new links up on its schedule). */
/** "fetch failed" alone is useless; add the underlying reason (e.g. ENOTFOUND) and the host we tried to reach. */
export function describeFetchError(e: unknown, url?: string): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  let host: string | undefined;
  try {
    host = url ? new URL(url).host : undefined;
  } catch {
    host = url ? `invalid URL "${url.slice(0, 60)}"` : undefined;
  }
  return [err?.message ?? String(e), err?.cause?.code ?? err?.cause?.message, host && `while calling ${host}`].filter(Boolean).join(" | ");
}

export async function dispatchWorker(): Promise<{ dispatched: boolean; note?: string }> {
  const token = opt("GH_DISPATCH_TOKEN");
  const repo = opt("GH_REPO");
  if (!token || !repo) return { dispatched: false, note: "GH_DISPATCH_TOKEN/GH_REPO not set; the worker will pick this up on its next scheduled run." };
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/worker.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clip-engine",
    },
    body: JSON.stringify({ ref: opt("GH_REF") ?? "main" }),
  });
  if (r.status === 204) return { dispatched: true };
  return { dispatched: false, note: `GitHub dispatch failed (HTTP ${r.status}); the worker will run on its schedule.` };
}

/** Where the download + clipping worker runs: "modal" (recommended), "github" (Actions) or "netlify" (background function + Cobalt). */
export function workerMode(): "local" | "modal" | "github" | "netlify" {
  const forced = opt("WORKER_MODE");
  if (forced === "local" || forced === "modal" || forced === "github" || forced === "netlify") return forced;
  if (opt("MODAL_WORKER_URL")) return "modal";
  return opt("COBALT_API_URL") ? "netlify" : "local";
}

/** Does the real launch. Modal can take a while to wake up, so this runs inside a Netlify background function. */
export async function launchWorker(): Promise<{ dispatched: boolean; note?: string }> {
  const mode = workerMode();
  if (mode === "local") return { dispatched: true, note: "Your worker polls the queue and will pick this up within a minute." };
  if (mode === "github") return dispatchWorker();
  try {
    if (mode === "modal") {
      const url = opt("MODAL_WORKER_URL");
      if (!url) return { dispatched: false, note: "MODAL_WORKER_URL is not set." };
      const r = await fetch(url, {
        method: "POST",
        headers: { "x-cron-secret": opt("CRON_SECRET") ?? "" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw new Error(`Modal responded HTTP ${r.status}`);
    } else {
      await trigger("fill-background");
    }
    return { dispatched: true };
  } catch (e) {
    return { dispatched: false, note: `Could not start the worker (${describeFetchError(e, mode === "modal" ? opt("MODAL_WORKER_URL") : opt("SITE_URL") ?? opt("URL"))}); it also runs on its schedule.` };
  }
}

/** What the page calls. Never waits on Modal: it hands off to a background function and returns at once. */
export async function startWorker(): Promise<{ dispatched: boolean; note?: string }> {
  if (workerMode() !== "modal") return launchWorker(); // local / github / netlify: nothing slow to wait on
  try {
    await trigger("start-worker-background");
    return { dispatched: true };
  } catch (e) {
    return { dispatched: false, note: `Could not start the worker (${describeFetchError(e, opt("SITE_URL") ?? opt("URL"))}); it also runs on its schedule.` };
  }
}
