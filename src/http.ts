import { timingSafeEqual } from "node:crypto";
import { opt } from "./env";

/** Shared-secret guard: `x-cron-secret: <CRON_SECRET>` or `Authorization: Bearer <CRON_SECRET>`. */
export function authorized(req: Request): boolean {
  const secret = opt("CRON_SECRET");
  if (!secret) return false;
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

/** Scheduled functions only have 30 s, so they hand the real work to a background function (15 min). */
export async function trigger(fn: string, depth = 0): Promise<void> {
  const site = opt("SITE_URL") ?? opt("URL");
  if (!site) throw new Error("Set SITE_URL (your Netlify site URL) so scheduled functions can reach background functions");
  const r = await fetch(`${site.replace(/\/$/, "")}/.netlify/functions/${fn}`, {
    method: "POST",
    headers: { "x-cron-secret": opt("CRON_SECRET") ?? "", "x-depth": String(depth) },
  });
  if (r.status >= 400) throw new Error(`trigger ${fn} -> HTTP ${r.status}`);
}

/** Turns an unexpected crash into a readable JSON error (shown on the page) instead of a bare 502. */
export const safe =
  (fn: (req: Request) => Promise<Response>) =>
  async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      console.error("[error]", msg);
      return json({ error: msg }, 500);
    }
  };
