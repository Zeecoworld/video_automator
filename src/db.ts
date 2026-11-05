import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { req } from "./env";
import type { ClipRow, Platform, Plan, SourceRow, Variant } from "./types";

let client: SupabaseClient | undefined;
export function sb(): SupabaseClient {
  return (client ??= createClient(req("SUPABASE_URL"), req("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
      // supabase-js wants a WebSocket even though we never use realtime; Node < 22 has none built in.
      realtime: { transport: WebSocket as unknown as never },
    }));
}

export const now = () => new Date();
const iso = (d: Date = now()) => d.toISOString();

function check<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

// ---------------------------------------------------------------- kv + locks
export async function kvGet(key: string): Promise<string | null> {
  const r = await sb().from("kv").select("value").eq("key", key).limit(1);
  return check(r, "kvGet")[0]?.value ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  check(await sb().from("kv").upsert({ key, value, updated_at: iso() }), "kvSet");
}

/** Best-effort lock so a cron run and a chained run never work the same queue at once. Returns a token or null. */
export async function acquireLock(name: string, ttlMs: number): Promise<string | null> {
  const key = `lock:${name}`;
  const cur = await kvGet(key);
  if (cur) {
    const exp = Number(cur.split("|")[0]);
    if (exp > Date.now()) return null;
  }
  const token = `${Date.now() + ttlMs}|${randomUUID()}`;
  await kvSet(key, token);
  await new Promise((r) => setTimeout(r, 400));
  return (await kvGet(key)) === token ? token : null;
}

export async function releaseLock(name: string, token: string): Promise<void> {
  if ((await kvGet(`lock:${name}`)) === token) await kvSet(`lock:${name}`, "0|released");
}

// ---------------------------------------------------------------- sources
export async function upsertSources(
  platform: Platform, items: { url: string; title?: string }[], variants: Variant[] = ["pad"], createdBy?: string,
): Promise<void> {
  // created_by is only sent when a signed-in user adds links, so databases without the new column keep working.
  const rows = items.map((s) => ({ platform, url: s.url, title: s.title ?? null, variants, ...(createdBy ? { created_by: createdBy } : {}) }));
  for (let i = 0; i < rows.length; i += 500) {
    check(
      await sb().from("sources").upsert(rows.slice(i, i + 500), { onConflict: "platform,url", ignoreDuplicates: true }),
      "upsertSources",
    );
  }
}

/** Re-pasting a link that failed before gives it a fresh start. */
export async function requeueFailed(platform: Platform, urls: string[]): Promise<void> {
  if (!urls.length) return;
  check(
    await sb().from("sources")
      .update({ status: "pending", attempts: 0, error: null, plan: null, rendered: 0, updated_at: iso() })
      .eq("platform", platform).eq("status", "failed").in("url", urls),
    "requeueFailed",
  );
}

/** A source that already has a plan but still has clips left to render. */
export async function resumableSource(platform: Platform): Promise<SourceRow | null> {
  const r = await sb().from("sources").select("*").eq("platform", platform).eq("status", "processing")
    .not("plan", "is", null).order("updated_at").limit(1);
  return (check(r, "resumableSource") as SourceRow[])[0] ?? null;
}

export async function claimNextPending(platform: Platform): Promise<SourceRow | null> {
  const r = await sb().from("sources").select("*").eq("platform", platform).eq("status", "pending")
    .order("position").order("created_at").limit(1);
  const src = (check(r, "claimNextPending") as SourceRow[])[0];
  if (!src) return null;
  const u = await sb().from("sources")
    .update({ status: "processing", attempts: src.attempts + 1, updated_at: iso() })
    .eq("id", src.id).eq("status", "pending").select();
  return (check(u, "claim") as SourceRow[])[0] ?? null;
}

export async function updateSource(id: string, fields: Partial<Omit<SourceRow, "plan">> & { plan?: Plan | null }): Promise<void> {
  check(await sb().from("sources").update({ ...fields, updated_at: iso() }).eq("id", id), "updateSource");
}

// ---------------------------------------------------------------- clips
export async function countBacklog(platform: Platform): Promise<number> {
  const r = await sb().from("clips").select("id", { count: "exact", head: true }).eq("platform", platform).in("status", ["ready", "posting"]);
  if (r.error) throw new Error(`countBacklog: ${r.error.message}`);
  return r.count ?? 0;
}

export async function futureSlots(platform: Platform): Promise<Date[]> {
  const r = await sb().from("clips").select("scheduled_at").eq("platform", platform)
    .in("status", ["ready", "posting"]).gte("scheduled_at", iso());
  return (check(r, "futureSlots") as { scheduled_at: string | null }[]).filter((x) => x.scheduled_at).map((x) => new Date(x.scheduled_at!));
}

export async function insertClip(row: Record<string, unknown>): Promise<void> {
  check(await sb().from("clips").insert(row), "insertClip");
}

export async function dueClips(platform: Platform, limit: number): Promise<ClipRow[]> {
  const r = await sb().from("clips").select("*").eq("platform", platform).eq("status", "ready")
    .lte("scheduled_at", iso()).order("scheduled_at").limit(limit);
  return check(r, "dueClips") as ClipRow[];
}

export async function claimClip(c: ClipRow): Promise<ClipRow | null> {
  const u = await sb().from("clips").update({ status: "posting", attempts: c.attempts + 1, updated_at: iso() })
    .eq("id", c.id).eq("status", "ready").select();
  return (check(u, "claimClip") as ClipRow[])[0] ?? null;
}

export async function updateClip(id: string, fields: Record<string, unknown>): Promise<void> {
  check(await sb().from("clips").update({ ...fields, updated_at: iso() }).eq("id", id), "updateClip");
}

// ---------------------------------------------------------------- housekeeping
export async function resetStale(hours = 3): Promise<void> {
  const cutoff = iso(new Date(Date.now() - hours * 3_600_000));
  check(await sb().from("sources").update({ status: "pending", updated_at: iso() })
    .eq("status", "processing").is("plan", null).lt("updated_at", cutoff), "resetStale sources");
  check(await sb().from("clips").update({ status: "ready", updated_at: iso() })
    .eq("status", "posting").lt("updated_at", cutoff), "resetStale clips");
}

export async function stats(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  const defs: [string, string[]][] = [["sources", ["pending", "processing", "done", "failed"]], ["clips", ["ready", "posting", "posted", "failed"]]];
  for (const [table, statuses] of defs) {
    for (const p of ["youtube", "tiktok"]) {
      for (const s of statuses) {
        const r = await sb().from(table).select("id", { count: "exact", head: true }).eq("platform", p).eq("status", s);
        (out[`${p}/${table}`] ??= {})[s] = r.count ?? 0;
      }
    }
  }
  return out;
}

export async function getClip(id: string): Promise<ClipRow | null> {
  const r = await sb().from("clips").select("*").eq("id", id).limit(1);
  return (check(r, "getClip") as ClipRow[])[0] ?? null;
}

export async function deleteClipRow(id: string): Promise<void> {
  check(await sb().from("clips").delete().eq("id", id), "deleteClipRow");
}

const CLIP_COLS =
  "id,platform,variant,title,headline,description,hashtags,status,scheduled_at,posted_at,platform_post_id,error,attempts,storage_provider,storage_url,created_at";

/** Everything the dashboard shows: link progress, upcoming/failed clips, and the latest posted ones. */
export async function queueView(): Promise<{ now: string; sources: unknown[]; clips: unknown[] }> {
  const s = await sb().from("sources")
    .select("id,platform,url,title,status,error,rendered,variants,duration_s,created_at,plan")
    .order("created_at", { ascending: false }).limit(40);
  const open = await sb().from("clips").select(CLIP_COLS).in("status", ["ready", "posting", "failed"])
    .order("scheduled_at", { ascending: true }).limit(200);
  const posted = await sb().from("clips").select(CLIP_COLS).eq("status", "posted")
    .order("posted_at", { ascending: false }).limit(40);
  const sources = (check(s, "queueView sources") as unknown as (Omit<SourceRow, "plan"> & { plan: Plan | null })[]).map(({ plan, ...rest }) => ({
    ...rest,
    planned: (plan?.highlights?.length ?? 0) * Math.max(1, rest.variants?.length ?? 1),
  }));
  return {
    now: new Date().toISOString(),
    sources,
    clips: [...(check(open, "queueView clips") as unknown[]), ...(check(posted, "queueView posted") as unknown[])],
  };
}

/** Posted clips whose file was not deleted yet (e.g. Cloudinary was briefly unreachable). */
export async function postedWithStorage(limit = 25): Promise<ClipRow[]> {
  const r = await sb().from("clips").select("*").eq("status", "posted").not("storage_key", "is", null).limit(limit);
  return check(r, "postedWithStorage") as ClipRow[];
}

/** Cheap check used by the polling worker: is there any link waiting or half-finished? */
export async function hasWork(): Promise<boolean> {
  const r = await sb().from("sources").select("id", { count: "exact", head: true }).in("status", ["pending", "processing"]);
  if (r.error) throw new Error(`hasWork: ${r.error.message}`);
  return (r.count ?? 0) > 0;
}

/** Remember who signed in (the `users` table in supabase/schema.sql). */
export async function touchUser(u: { id: string; email: string }): Promise<void> {
  check(await sb().from("users").upsert({ id: u.id, email: u.email, last_seen: iso() }, { onConflict: "id" }), "touchUser");
}

/** Links that are waiting or in progress (used to decide whether the backup worker should run). */
export async function openSources(): Promise<{ status: string; created_at: string; updated_at: string }[]> {
  const r = await sb().from("sources").select("status,created_at,updated_at").in("status", ["pending", "processing"]).limit(200);
  return check(r, "openSources") as { status: string; created_at: string; updated_at: string }[];
}

/** Delete posted clips and finished links older than `days`, but never a link that still has clips waiting to post. */
export async function pruneOld(days: number): Promise<{ clips: number; sources: number }> {
  const cutoff = iso(new Date(Date.now() - days * 86_400_000));
  const c = await sb().from("clips").delete().eq("status", "posted").lt("posted_at", cutoff).select("id");
  const clips = (check(c, "pruneOld clips") as unknown[]).length;
  const old = await sb().from("sources").select("id").in("status", ["done", "failed"]).lt("updated_at", cutoff).limit(500);
  const ids = (check(old, "pruneOld sources") as { id: string }[]).map((x) => x.id);
  if (!ids.length) return { clips, sources: 0 };
  const busy = await sb().from("clips").select("source_id").in("source_id", ids).in("status", ["ready", "posting", "failed"]);
  const keep = new Set((check(busy, "pruneOld busy") as { source_id: string }[]).map((x) => x.source_id));
  const del = ids.filter((id) => !keep.has(id));
  if (del.length) check(await sb().from("sources").delete().in("id", del), "pruneOld delete");
  return { clips, sources: del.length };
}
