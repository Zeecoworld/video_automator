import { loadConfig } from "../../src/config";
import * as db from "../../src/db";
import { authorized, trigger } from "../../src/http";
import { log } from "../../src/runtime";
import { runWorker } from "../../src/worker";

const BUDGET_MS = 13 * 60_000; // Netlify background functions are killed at 15 minutes
const MIN_START_MS = 4 * 60_000;
const MAX_CHAIN = 8;

export default async (req: Request) => {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  const depth = Number(req.headers.get("x-depth") ?? 0);
  const lock = await db.acquireLock("worker", 14 * 60_000);
  if (!lock) {
    log.info("worker already running; skipping");
    return new Response("busy", { status: 202 });
  }
  let more = false;
  try {
    const r = await runWorker(loadConfig(), Date.now() + BUDGET_MS, { minStartMs: MIN_START_MS });
    more = r.more;
    if (r.errors) log.error(`worker finished with ${r.errors} error(s)`);
  } catch (e) {
    log.error(`worker crashed: ${(e as Error).message}`);
  } finally {
    await db.releaseLock("worker", lock);
  }
  if (more && depth < MAX_CHAIN) await trigger("fill-background", depth + 1).catch((e) => log.error(String(e)));
  return new Response("done", { status: 202 });
};
