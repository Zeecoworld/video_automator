import type { Config } from "../config";
import * as db from "../db";
import { opt, req } from "../env";
import { PlatformLimit } from "../errors";
import { log } from "../runtime";
import type { ClipRow } from "../types";
import { hashtagStr } from "./index";

const API = "https://open.tiktokapis.com";
const LIMIT_CODES = new Set(["rate_limit_exceeded", "spam_risk_too_many_posts", "spam_risk_too_many_pending_share"]);
const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TikTokPoster {
  private constructor(private token: string, private cfg: Config) {}

  /** Refresh tokens can rotate, so the newest one is persisted in Supabase (kv). */
  static async create(cfg: Config): Promise<TikTokPoster> {
    const seed = opt("TIKTOK_REFRESH_TOKEN") ?? "";
    const [stored, storedSeed] = [await db.kvGet("tiktok_refresh_token"), await db.kvGet("tiktok_seed")];
    const rt = stored && storedSeed === seed ? stored : seed;
    if (!rt) throw new Error("Missing TIKTOK_REFRESH_TOKEN");
    const r = await fetch(`${API}/v2/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: req("TIKTOK_CLIENT_KEY"), client_secret: req("TIKTOK_CLIENT_SECRET"),
        grant_type: "refresh_token", refresh_token: rt,
      }),
    });
    const j = (await r.json()) as { access_token?: string; refresh_token?: string };
    if (!j.access_token) throw new Error(`TikTok token refresh failed: ${JSON.stringify(j).slice(0, 200)}`);
    await db.kvSet("tiktok_refresh_token", j.refresh_token ?? rt);
    await db.kvSet("tiktok_seed", seed);
    return new TikTokPoster(j.access_token, cfg);
  }

  private async api<T = Record<string, unknown>>(path: string, payload: unknown): Promise<T> {
    const r = await fetch(API + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(payload),
    });
    const j = (await r.json()) as { data?: T; error?: { code?: string; message?: string } };
    const code = j.error?.code ?? "ok";
    if (code !== "ok") {
      if (LIMIT_CODES.has(code)) throw new PlatformLimit(`TikTok ${code}: ${j.error?.message}`);
      throw new Error(`TikTok ${path} -> ${code}: ${j.error?.message}`);
    }
    return (j.data ?? {}) as T;
  }

  async post(video: Buffer, clip: ClipRow): Promise<string> {
    const size = video.length;
    if (size > MAX_SINGLE_CHUNK) throw new Error(`clip is ${(size / 1e6).toFixed(0)} MB; single-chunk limit is 64 MB`);
    const source = { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 };
    const caption = `${clip.title ?? ""}\n${hashtagStr(clip)}`.trim().slice(0, 2200);

    let init: { publish_id: string; upload_url: string };
    if (this.cfg.tiktok.mode === "direct") {
      const info = await this.api<{ privacy_level_options?: string[] }>("/v2/post/publish/creator_info/query/", {});
      const opts = info.privacy_level_options ?? [];
      const wanted = this.cfg.tiktok.privacy;
      const privacy = opts.includes(wanted) ? wanted : opts.includes("SELF_ONLY") ? "SELF_ONLY" : (opts[0] ?? "SELF_ONLY");
      if (privacy !== wanted) log.warn(`TikTok privacy ${wanted} not allowed for this account (allowed: ${opts.join(",")}); using ${privacy}`);
      init = await this.api("/v2/post/publish/video/init/", {
        post_info: {
          title: caption, privacy_level: privacy, disable_duet: false, disable_comment: false,
          disable_stitch: false, video_cover_timestamp_ms: 1000,
        },
        source_info: source,
      });
    } else {
      init = await this.api("/v2/post/publish/inbox/video/init/", { source_info: source });
    }

    const up = await fetch(init.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${size - 1}/${size}` },
      body: new Uint8Array(video),
    });
    if (![200, 201, 206].includes(up.status)) throw new Error(`TikTok upload failed: ${up.status} ${(await up.text()).slice(0, 200)}`);

    for (let i = 0; i < 60; i++) {
      const st = await this.api<{ status?: string; fail_reason?: string }>("/v2/post/publish/status/fetch/", { publish_id: init.publish_id });
      if (st.status === "PUBLISH_COMPLETE" || st.status === "SEND_TO_USER_INBOX") {
        log.info(`TikTok ${st.status} (${init.publish_id})`);
        return init.publish_id;
      }
      if (st.status === "FAILED") throw new Error(`TikTok publish failed: ${st.fail_reason}`);
      await sleep(5000);
    }
    log.warn(`TikTok status still pending after 5 min for ${init.publish_id}; assuming accepted`);
    return init.publish_id;
  }
}
