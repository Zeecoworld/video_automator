import { loadConfig } from "../src/config";
import * as db from "../src/db";
import { prepareCookies } from "../src/cookies";
import { log } from "../src/runtime";
import { runWorker } from "../src/worker";

const BUDGET_MS = 5 * 3_600_000 + 20 * 60_000; // GitHub-hosted jobs are capped at 6 h

if (prepareCookies()) log.info("YouTube cookies loaded from the environment.");
const lock = await db.acquireLock("worker", 6 * 3_600_000);
if (!lock) {
  log.info("another worker is already running; exiting");
  process.exit(0);
}
let code = 0;
try {
  const r = await runWorker(loadConfig(), Date.now() + BUDGET_MS);
  log.info(`worker finished: ${r.processed} link(s) processed, ${r.errors} error(s)`);
  if (r.errors) code = 1;
} catch (e) {
  log.error(`worker crashed: ${(e as Error).stack ?? e}`);
  code = 1;
} finally {
  await db.releaseLock("worker", lock);
}
process.exit(code);
