import { serverless } from "./env";
import type { Platform } from "./types";

export interface PlatformCfg {
  enabled: boolean;
  perDay: number;
}

export interface Config {
  timezone: string;
  windowStart: string;
  windowEnd: string;
  lookaheadDays: number;
  maxSourceMinutes: number;
  maxPublishPerRun: number;
  /** Rough time one clip takes to render in a function; used to decide whether another fits in the time budget. */
  renderBudgetMs: number;
  clip: { minS: number; maxS: number; wholeVideoMinS: number; captions: boolean; perSourceMin: number; perSourceMax: number; accent: string };
  render: { width: number; height: number; preset: string; crf: number; loudnorm: boolean; fontName: string };
  whisper: { model: string };
  download: { quality: string; maxMb: number };
  gemini: { models: string[] };
  tiktok: { mode: "direct" | "inbox"; privacy: string };
  youtube: { categoryId: string };
  platforms: Record<Platform, PlatformCfg>;
}

export const defaultConfig: Config = {
  timezone: "Africa/Lagos",
  windowStart: "08:00",
  windowEnd: "22:00",
  lookaheadDays: 7,
  maxSourceMinutes: 120,
  maxPublishPerRun: 2,
  renderBudgetMs: 3 * 60_000,
  clip: { minS: 20, maxS: 59, wholeVideoMinS: 3, captions: true, perSourceMin: 3, perSourceMax: 8, accent: "#00ea90" },
  render: { width: 1080, height: 1920, preset: "veryfast", crf: 22, loudnorm: true, fontName: "DejaVu Sans" },
  // Functions have ~512 MB of /tmp, so on Netlify we ask Cobalt for 720p and cap the download size.
  whisper: { model: "small" },
  download: { quality: "720", maxMb: serverless ? 300 : 2000 },
  gemini: { models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"] },
  tiktok: { mode: "direct", privacy: "PUBLIC_TO_EVERYONE" },
  youtube: { categoryId: "28" },
  platforms: {
    youtube: { enabled: true, perDay: 5 },
    tiktok: { enabled: true, perDay: 10 },
  },
};

/** Defaults, with a few environment overrides so you can tune without redeploying code. */
export function loadConfig(): Config {
  const c: Config = structuredClone(defaultConfig);
  const e = process.env;
  if (serverless) { c.render.width = 720; c.render.height = 1280; } // fits a function's CPU and the 15-minute limit
  if (e.WHISPER_MODEL) c.whisper.model = e.WHISPER_MODEL;
  if (e.CAPTIONS === "off") c.clip.captions = false;
  if (e.COBALT_QUALITY) c.download.quality = e.COBALT_QUALITY;
  if (e.MAX_DOWNLOAD_MB) c.download.maxMb = Number(e.MAX_DOWNLOAD_MB);
  if (e.GEMINI_MODELS) c.gemini.models = e.GEMINI_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  if (e.TIKTOK_MODE === "inbox" || e.TIKTOK_MODE === "direct") c.tiktok.mode = e.TIKTOK_MODE;
  if (e.TIKTOK_PRIVACY) c.tiktok.privacy = e.TIKTOK_PRIVACY;
  if (e.YOUTUBE_PER_DAY) c.platforms.youtube.perDay = Number(e.YOUTUBE_PER_DAY);
  if (e.TIKTOK_PER_DAY) c.platforms.tiktok.perDay = Number(e.TIKTOK_PER_DAY);
  if (e.POSTING_TIMEZONE) c.timezone = e.POSTING_TIMEZONE;
  if (e.RENDER_WIDTH && e.RENDER_HEIGHT) {
    c.render.width = Number(e.RENDER_WIDTH);
    c.render.height = Number(e.RENDER_HEIGHT);
  }
  return c;
}
