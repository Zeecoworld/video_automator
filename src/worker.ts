import type { Config } from "./config";
import * as db from "./db";
import { SourceSkip } from "./errors";
import { analyzeSource, errMsg, jobsOf, renderJobs, rm, tmp } from "./pipeline";
import { log } from "./runtime";
import type { Platform } from "./types";
import { download } from "./download";
import type { Download } from "./ytdlp";

const MAX_ATTEMPTS = 3;

const platformsOf = (cfg: Config) => (Object.keys(cfg.platforms) as Platform[]).filter((p) => cfg.platforms[p].enabled);

/**
 * Pull pending links, download them, let AI choose the highlights, cut the variations, upload and schedule them.
 * Runs inside a Netlify background function (downloading through Cobalt) or on any machine with yt-dlp + ffmpeg.
 */
export async function runWorker(
  cfg: Config, deadline: number, opts: { minStartMs?: number } = {},
): Promise<{ errors: number; processed: number; more: boolean }> {
  const minStartMs = opts.minStartMs ?? 10 * 60_000; // don't begin a new video with less than this left
  await db.resetStale();
  const root = tmp("worker-");
  const downloads = new Map<string, Promise<Download>>(); // the same link pasted for YouTube + TikTok downloads once
  let errors = 0;
  let processed = 0;
  try {
    for (const platform of platformsOf(cfg)) {
      const perDay = cfg.platforms[platform].perDay;
      const target = perDay * cfg.lookaheadDays;
      let backlog = await db.countBacklog(platform);
      log.info(`${platform}: ${backlog} clips queued, target ${target}`);
      while (backlog < target) {
        if (deadline - Date.now() < minStartMs) { log.info("time budget used up; stopping"); return { errors, processed, more: true }; }
        let src = (await db.resumableSource(platform)) ?? (await db.claimNextPending(platform));
        if (!src) { log.info(`${platform}: no pending links`); break; }
        try {
          let dl = downloads.get(src.url);
          if (!dl) {
            const dir = `${root}/${downloads.size}`;
            (await import("node:fs")).mkdirSync(dir, { recursive: true });
            dl = download(src.url, dir, cfg);
            downloads.set(src.url, dl);
          }
          const video = await dl;
          if (!src.plan) {
            const variants = src.variants?.length ? src.variants : ["pad" as const];
            const wanted = Math.ceil(Math.max(1, target - backlog) / variants.length);
            const nMax = Math.min(cfg.clip.perSourceMax, Math.max(cfg.clip.perSourceMin, wanted));
            const plan = await analyzeSource(src, video.path, cfg, nMax, video.title);
            await db.updateSource(src.id, { plan, title: plan.title, duration_s: plan.durationS, rendered: 0 });
            src = { ...src, plan, title: plan.title, rendered: 0 };
            log.info(`${platform}: ${jobsOf(plan, src.variants).length} clips planned from "${plan.title}"`);
          }
          const r = await renderJobs(src, video.path, cfg, deadline, perDay);
          backlog += r.created;
          processed += 1;
          if (!r.finished) { log.info("time budget used up mid-source; it will resume next run"); return { errors, processed, more: true }; }
        } catch (e) {
          if (e instanceof SourceSkip) {
            log.warn(`Skipping ${src.url}: ${e.message}`);
            await db.updateSource(src.id, { status: "failed", error: errMsg(e) });
          } else {
            errors += 1;
            log.error(`Link failed: ${src.url}: ${errMsg(e)}`);
            const attempts = src.plan ? src.attempts + 1 : src.attempts; // claiming already counted the first attempt
            await db.updateSource(src.id, {
              status: attempts >= MAX_ATTEMPTS ? "failed" : src.plan ? "processing" : "pending",
              error: errMsg(e),
              attempts,
            });
            if (src.plan) break;
          }
        }
      }
    }
  } finally {
    rm(root);
  }
  return { errors, processed, more: false };
}
