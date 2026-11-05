import { launchWorker } from "../../src/github";
import { authorized } from "../../src/http";
import { log } from "../../src/runtime";

/** Wakes the Modal worker. Background function (up to 15 min), so a slow Modal cold start never blocks the page. */
export default async (req: Request) => {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  const r = await launchWorker();
  if (r.dispatched) log.info("worker started");
  else log.error(r.note ?? "worker did not start");
  return new Response("done", { status: 202 });
};
