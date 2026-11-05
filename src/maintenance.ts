import * as db from "./db";
import { log } from "./runtime";
import { cleanupPosted } from "./publish";

export interface OpenSource {
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Should the GitHub Actions backup step in? Yes when links have been waiting longer than `minutes` and no worker
 * (Modal, Render, your PC) currently holds the worker lock. Pure so it can be tested.
 */
export function shouldFallback(open: OpenSource[], lockValue: string | null, nowMs: number, minutes: number): boolean {
  const lockActive = lockValue ? Number(lockValue.split("|")[0]) > nowMs : false;
  if (lockActive) return false;
  return open.some((s) => nowMs - Date.parse(s.status === "pending" ? s.created_at : s.updated_at) > minutes * 60_000);
}

export async function fallbackNeeded(minutes = Number(process.env.FALLBACK_AFTER_MIN ?? 45)): Promise<boolean> {
  return shouldFallback(await db.openSources(), await db.kvGet("lock:worker"), Date.now(), minutes);
}

/** Scheduled housekeeping: free stuck jobs, retry file deletions, trim old rows. */
export async function runMaintenance(pruneDays = 90): Promise<{ deletedFiles: number; prunedClips: number; prunedSources: number }> {
  await db.resetStale();
  const deletedFiles = await cleanupPosted();
  const pruned = await db.pruneOld(pruneDays);
  log.info(`maintenance: ${deletedFiles} stored file(s) deleted, ${pruned.clips} old clip row(s) and ${pruned.sources} old link(s) pruned`);
  log.info(`queue: ${JSON.stringify(await db.stats())}`);
  return { deletedFiles, prunedClips: pruned.clips, prunedSources: pruned.sources };
}
