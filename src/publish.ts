import type { Config } from "./config";
import * as db from "./db";
import { PlatformLimit } from "./errors";
import { getPoster } from "./platforms";
import { log } from "./runtime";
import * as storage from "./storage";
import type { Platform } from "./types";

const MAX_ATTEMPTS = 3;
const platformsOf = (cfg: Config) => (Object.keys(cfg.platforms) as Platform[]).filter((p) => cfg.platforms[p].enabled);
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

export async function runPublish(cfg: Config, dryRun = false): Promise<number> {
  await db.resetStale();
  let errors = 0;
  for (const platform of platformsOf(cfg)) {
    const due = await db.dueClips(platform, cfg.maxPublishPerRun);
    if (!due.length) continue;
    if (dryRun) {
      for (const c of due) log.info(`[dry-run] ${platform} would post: ${c.title} (slot ${c.scheduled_at})`);
      continue;
    }
    let poster;
    try {
      poster = await getPoster(platform, cfg);
    } catch (e) {
      errors += 1;
      log.error(`${platform}: authentication failed: ${errMsg(e)}`);
      // Show the reason on the page instead of leaving the clip silently "ready".
      for (const c of due) await db.updateClip(c.id, { error: `Could not connect to ${platform}: ${errMsg(e)}` }).catch(() => undefined);
      continue;
    }
    for (const clip of due) {
      const claimed = await db.claimClip(clip);
      if (!claimed) continue;
      try {
        const video = await storage.fetchClip(claimed.storage_provider!, claimed.storage_key!, claimed.storage_url ?? "");
        const postId = await poster.post(video, claimed);
        await db.updateClip(claimed.id, { status: "posted", posted_at: db.now().toISOString(), platform_post_id: postId, error: null });
        log.info(`${platform}: posted ${claimed.title}`);
        try {
          await storage.deleteClip(claimed.storage_provider!, claimed.storage_key!);
          await db.updateClip(claimed.id, { storage_key: null, storage_url: null });
        } catch (e) {
          log.warn(`posted but could not delete storage object: ${errMsg(e).slice(0, 200)}`);
        }
      } catch (e) {
        if (e instanceof PlatformLimit) {
          log.warn(`${platform}: limit reached, pausing this platform: ${e.message}`);
          await db.updateClip(claimed.id, { status: "ready", attempts: claimed.attempts - 1 });
          break;
        }
        errors += 1;
        log.error(`${platform}: failed to post ${claimed.id}: ${errMsg(e)}`);
        await db.updateClip(claimed.id, { status: claimed.attempts >= MAX_ATTEMPTS ? "failed" : "ready", error: errMsg(e) });
      }
    }
  }
  await cleanupPosted();
  return errors;
}

/** Retry deleting stored files of clips that were posted successfully. Never touches unposted clips. */
export async function cleanupPosted(): Promise<number> {
  let removed = 0;
  for (const c of await db.postedWithStorage()) {
    try {
      await storage.deleteClip(c.storage_provider!, c.storage_key!);
      await db.updateClip(c.id, { storage_key: null, storage_url: null });
      removed += 1;
    } catch (e) {
      log.warn(`cleanup of ${c.storage_key} failed, will retry: ${errMsg(e).slice(0, 150)}`);
    }
  }
  return removed;
}
