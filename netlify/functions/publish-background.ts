import { loadConfig } from "../../src/config";
import * as db from "../../src/db";
import { authorized } from "../../src/http";
import { runPublish } from "../../src/publish";
import { log } from "../../src/runtime";

export default async (req: Request) => {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  const lock = await db.acquireLock("publish", 14 * 60_000);
  if (!lock) return new Response("busy", { status: 202 });
  try {
    const errors = await runPublish(loadConfig());
    if (errors) log.error(`publish finished with ${errors} error(s)`);
  } catch (e) {
    log.error(`publish crashed: ${(e as Error).message}`);
  } finally {
    await db.releaseLock("publish", lock);
  }
  return new Response("done", { status: 202 });
};
