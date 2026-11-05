import type { Config } from "../config";
import type { ClipRow, Platform } from "../types";

export const hashtagStr = (clip: Pick<ClipRow, "hashtags">) => (clip.hashtags ?? []).map((t) => `#${t}`).join(" ");

export interface Poster {
  post(video: Buffer, clip: ClipRow): Promise<string>;
}

export async function getPoster(platform: Platform, cfg: Config): Promise<Poster> {
  if (platform === "youtube") return (await import("./youtube")).YouTubePoster.create(cfg);
  return (await import("./tiktok")).TikTokPoster.create(cfg);
}
