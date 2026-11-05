import type { Config } from "@netlify/functions";
import * as db from "../../src/db";
import { authorize } from "../../src/auth";
import { json, safe, trigger } from "../../src/http";
import { log } from "../../src/runtime";
import * as storage from "../../src/storage";

/**
 * POST /api/clip  { id, action: "post-now" | "reschedule" | "retry" | "cancel", at?: ISO date }
 * The dashboard's buttons. A clip that is currently posting or already posted is never touched.
 */
export default safe(async (req: Request) => {
  const who = await authorize(req);
  if (!who.ok) return json({ error: who.error }, who.status ?? 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = (await req.json().catch(() => null)) as { id?: string; action?: string; at?: string } | null;
  if (!body?.id || !body.action) return json({ error: "id and action are required" }, 400);
  const clip = await db.getClip(body.id);
  if (!clip) return json({ error: "clip not found" }, 404);
  if (clip.status === "posting" || clip.status === "posted") return json({ error: `this clip is already ${clip.status}` }, 409);

  switch (body.action) {
    case "post-now": {
      await db.updateClip(clip.id, { status: "ready", attempts: 0, error: null, scheduled_at: new Date().toISOString() });
      let note: string | undefined;
      try {
        await trigger("publish-background");
      } catch (e) {
        note = `Saved, but could not start posting right now (${(e as Error).message}). It will post at the next 30-minute check.`;
      }
      return json({ ok: true, note });
    }
    case "reschedule": {
      const at = new Date(body.at ?? "");
      if (Number.isNaN(at.getTime())) return json({ error: "invalid date" }, 400);
      if (at.getTime() > Date.now() + 366 * 86_400_000) return json({ error: "date is too far in the future" }, 400);
      await db.updateClip(clip.id, { status: "ready", attempts: 0, error: null, scheduled_at: at.toISOString() });
      return json({ ok: true });
    }
    case "retry": {
      await db.updateClip(clip.id, { status: "ready", attempts: 0, error: null });
      return json({ ok: true });
    }
    case "cancel": {
      if (clip.storage_provider && clip.storage_key) {
        await storage.deleteClip(clip.storage_provider, clip.storage_key).catch((e) => log.warn(`could not delete file: ${e}`));
      }
      await db.deleteClipRow(clip.id);
      return json({ ok: true });
    }
    default:
      return json({ error: "unknown action" }, 400);
  }
});

export const config: Config = { path: "/api/clip" };
