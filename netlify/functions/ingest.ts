import type { Config } from "@netlify/functions";
import * as db from "../../src/db";
import { startWorker } from "../../src/github";
import { authorize } from "../../src/auth";
import { json, safe } from "../../src/http";
import { extractLinks } from "../../src/links";
import type { Platform, Variant } from "../../src/types";

/**
 * POST /api/ingest
 * { "links": "<pasted text with YouTube / Instagram URLs>", "platforms": ["youtube","tiktok"], "variations": 1 | 2 }
 * Saves each link for every selected platform and starts the download/clip worker.
 */
export default safe(async (req: Request) => {
  const who = await authorize(req);
  if (!who.ok) return json({ error: who.error }, who.status ?? 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = (await req.json().catch(() => null)) as { links?: string; urls?: string[]; platforms?: string[]; variations?: number } | null;
  if (!body) return json({ error: "invalid JSON" }, 400);

  const links = extractLinks([body.links ?? "", ...(body.urls ?? [])].join("\n"));
  if (!links.length) return json({ error: "no http(s) links found in what you pasted" }, 400);
  const platforms = (body.platforms ?? ["youtube", "tiktok"]).filter((p): p is Platform => p === "youtube" || p === "tiktok");
  if (!platforms.length) return json({ error: "choose at least one platform" }, 400);
  const variants: Variant[] = body.variations === 2 ? ["pad", "fill"] : ["pad"];

  const urls = links.map((l) => ({ url: l.url }));
  for (const p of platforms) {
    await db.upsertSources(p, urls, variants, who.user?.id);
    await db.requeueFailed(p, links.map((l) => l.url));
  }
  const d = await startWorker();
  return json({
    queued: links.length,
    platforms,
    variants,
    unsupportedHint: links.filter((l) => l.kind === "other").length ? "Some links are not YouTube/Instagram; they will be tried anyway." : undefined,
    workerStarted: d.dispatched,
    note: d.note,
  });
});

export const config: Config = { path: "/api/ingest" };
