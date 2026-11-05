export type Platform = "youtube" | "tiktok";
/** pad = whole frame over a blurred backdrop; fill = centre-crop to fill the vertical frame */
export type Variant = "pad" | "fill";

export interface Silence {
  start: number;
  end: number;
}

/** One spoken word with absolute timestamps (seconds in the source video). */
export interface Cap {
  s: number;
  e: number;
  t: string;
}

export interface Highlight {
  startS: number;
  endS: number;
  headline: string;
  title: string;
  description: string;
  hashtags: string[];
  score: number;
  /** Words spoken inside this clip, used for burned-in subtitles (only with the local Whisper pipeline). */
  words?: Cap[];
}

export interface Plan {
  title: string;
  durationS: number;
  hasAudio: boolean;
  highlights: Highlight[];
}

export interface SourceRow {
  id: string;
  platform: Platform;
  url: string;
  title: string | null;
  position: number;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  plan: Plan | null;
  variants: Variant[];
  rendered: number;
  duration_s: number | null;
  error: string | null;
}

export interface ClipRow {
  id: string;
  source_id: string;
  platform: Platform;
  idx: number;
  start_s: number;
  end_s: number;
  headline: string;
  title: string;
  description: string;
  hashtags: string[];
  variant: Variant;
  storage_provider: "r2" | "cloudinary" | "supabase" | null;
  storage_key: string | null;
  storage_url: string | null;
  status: "ready" | "posting" | "posted" | "failed";
  scheduled_at: string | null;
  attempts: number;
}
