import type { Config } from "../config";
import { opt } from "../env";
import { PlatformLimit } from "../errors";
import { log } from "../runtime";
import type { ClipRow } from "../types";
import { loadConnection, refreshAccessToken } from "../youtube-auth";
import { hashtagStr } from "./index";

const LIMIT_REASONS = ["quotaExceeded", "uploadLimitExceeded", "dailyLimitExceeded", "rateLimitExceeded"];

async function fail(r: Response, what: string): Promise<never> {
  const text = await r.text();
  if (LIMIT_REASONS.some((x) => text.includes(x))) throw new PlatformLimit(`YouTube limit: ${text.slice(0, 200)}`);
  throw new Error(`YouTube ${what} HTTP ${r.status}: ${text.slice(0, 300)}`);
}

export class YouTubePoster {
  private constructor(private token: string, private cfg: Config) {}

  /** Uses the channel connected from the dashboard; falls back to YT_REFRESH_TOKEN if you set one by hand. */
  static async create(cfg: Config): Promise<YouTubePoster> {
    const conn = await loadConnection();
    const refresh = conn?.refresh_token ?? opt("YT_REFRESH_TOKEN");
    if (!refresh) throw new Error("YouTube is not connected. Open the dashboard and press Connect YouTube.");
    return new YouTubePoster(await refreshAccessToken(refresh), cfg);
  }

  async post(video: Buffer, clip: ClipRow): Promise<string> {
    const meta = {
      snippet: {
        title: (clip.title || "Clip").slice(0, 100),
        description: `${clip.description ?? ""}\n\n${hashtagStr(clip)} #Shorts`.trim().slice(0, 4900),
        tags: (clip.hashtags ?? []).slice(0, 15),
        categoryId: this.cfg.youtube.categoryId,
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    };
    const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(video.length),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(meta),
    });
    if (!init.ok) await fail(init, "init");
    const loc = init.headers.get("location");
    if (!loc) throw new Error("YouTube did not return an upload URL");
    const up = await fetch(loc, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: new Uint8Array(video) });
    if (!up.ok) await fail(up, "upload");
    const j = (await up.json()) as { id: string };
    log.info(`YouTube uploaded ${j.id}`);
    return j.id;
  }
}
