import { loadConfig } from "../src/config";
import * as db from "../src/db";
import { prepareCookies } from "../src/cookies";
import { log } from "../src/runtime";
import { runWorker } from "../src/worker";

/**
 * Long-running worker for your own computer or a VPS (no Modal, no URL to call).
 * It watches the Supabase queue and processes new links within about a minute.
 */
const IDLE_MS = Number(process.env.POLL_SECONDS ?? 60) * 1000;
const BUDGET_MS = 5 * 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (prepareCookies()) log.info("YouTube cookies loaded from the environment.");
log.info(`Local worker started. Checking the queue every ${IDLE_MS / 1000}s.`);
for (;;) {
  let waitMs = IDLE_MS;
  try {
    if (await db.hasWork()) {
      const lock = await db.acquireLock("worker", 6 * 3_600_000);
      if (lock) {
        try {
          const r = await runWorker(loadConfig(), Date.now() + BUDGET_MS);
          if (r.processed > 0) waitMs = 2000; // there may be more waiting; check again soon
          if (r.errors) log.error(`${r.errors} link(s) failed this round`);
        } finally {
          await db.releaseLock("worker", lock);
        }
      }
    }
  } catch (e) {
    log.error(`worker loop error: ${(e as Error).message}`);
  }
  await sleep(waitMs);
}
