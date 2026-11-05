import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { fontEnv, isHttp, runFfmpeg } from "./ffmpeg";
import type { Cap, Highlight, Variant } from "./types";

/** "#00ea90" -> ASS &HAABBGGRR */
export function assColor(hex: string): string {
  const h = hex.replace("#", "").padStart(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export function assTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

export function wrapHeadline(text: string, width = 18): string {
  const words = text.replace(/[^\p{L}\p{N}\s.,!?'’:;%$&@/+-]/gu, "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return (lines.length ? lines : ["WATCH THIS"]).join("\\N");
}

/** Group words into short on-screen caption chunks (max 4 words, split on pauses). */
export function captionChunks(words: Cap[]): Cap[][] {
  const chunks: Cap[][] = [];
  let cur: Cap[] = [];
  for (const w of words) {
    if (cur.length && (cur.length >= 4 || w.s - cur[cur.length - 1].e > 0.7 || w.e - cur[0].s > 2.8)) { chunks.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Headline in an accent-coloured box at the top, plus optional burned-in subtitles from Whisper word timestamps.
 *  ffmpeg-static has no drawtext, so libass draws both. */
export function buildHeadlineAss(
  headline: string, w: number, h: number, cfg: Config, durationS: number, words: Cap[] = [], startS = 0,
): string {
  const size = Math.round(w * 0.061);
  const pad = Math.round(w * 0.019);
  const marginV = Math.round(h * 0.1);
  const box = assColor(cfg.clip.accent);
  const capSize = Math.round(w * 0.066);
  const events = [`Dialogue: 0,0:00:00.00,${assTime(Math.max(1, durationS))},Headline,,0,0,0,,${wrapHeadline(headline)}`];
  const chunks = captionChunks(words);
  chunks.forEach((ch, i) => {
    const t0 = Math.max(0, ch[0].s - startS);
    const next = chunks[i + 1] ? chunks[i + 1][0].s - startS : ch[ch.length - 1].e - startS + 0.3;
    const t1 = Math.min(Math.max(next, t0 + 0.2), ch[ch.length - 1].e - startS + 0.6);
    const text = ch.map((x) => x.t).join(" ").toUpperCase().replace(/[{}\\]/g, "");
    events.push(`Dialogue: 0,${assTime(t0)},${assTime(t1)},Cap,,0,0,0,,${text}`);
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Headline,${cfg.render.fontName},${size},&H00000000,&H00000000,${box},${box},-1,0,0,0,100,100,0,0,3,${pad},0,8,${Math.round(w * 0.055)},${Math.round(w * 0.055)},${marginV},1
Style: Cap,${cfg.render.fontName},${capSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.round(w * 0.008)},0,2,${Math.round(w * 0.06)},${Math.round(w * 0.06)},${Math.round(h * 0.2)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

export function buildFilter(w: number, h: number, variant: Variant = "pad"): string {
  const sw = Math.max(2, Math.round(w / 8));
  const sh = Math.max(2, Math.round(h / 8));
  const base =
    variant === "fill"
      ? [`[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[v0]`]
      : [
          "[0:v]split=2[a][b]",
          `[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},scale=${sw}:${sh},boxblur=4:2,scale=${w}:${h},eq=brightness=-0.1[bg]`,
          `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
          "[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]",
        ];
  return [...base, "[v0]subtitles=headline.ass:fontsdir=FONTS[v]"].join(";");
}

export interface RenderArgs {
  srcUrl: string;
  h: Highlight;
  hasAudio: boolean;
  out: string;
  workdir: string;
  cfg: Config;
  variant?: Variant;
}

/** Cut [startS, endS] straight from the (remote) source and render a vertical clip. Range requests mean we never download the whole file. */
export async function renderClip(a: RenderArgs): Promise<void> {
  const { cfg, h } = a;
  const { width: w, height: ht } = cfg.render;
  fs.mkdirSync(a.workdir, { recursive: true });
  const dur = h.endS - h.startS;
  fs.writeFileSync(path.join(a.workdir, "headline.ass"), buildHeadlineAss(h.headline, w, ht, cfg, dur, cfg.clip.captions ? h.words ?? [] : [], h.startS));
  const { env, fontsDir } = fontEnv();
  const graph = buildFilter(w, ht, a.variant ?? "pad").replace("FONTS", fontsDir);
  const net = isHttp(a.srcUrl) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : [];
  const args = [
    "-y", ...net, "-ss", h.startS.toFixed(3), "-t", dur.toFixed(3), "-i", a.srcUrl,
    "-filter_complex", graph, "-map", "[v]",
  ];
  if (a.hasAudio) {
    args.push("-map", "0:a:0");
    if (cfg.render.loudnorm) args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
    args.push("-c:a", "aac", "-b:a", "128k", "-ar", "44100");
  }
  args.push(
    "-c:v", "libx264", "-preset", cfg.render.preset, "-crf", String(cfg.render.crf),
    "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", path.resolve(a.out),
  );
  const r = await runFfmpeg(args, { cwd: a.workdir, env, timeoutMs: 12 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(a.out) || fs.statSync(a.out).size === 0) {
    throw new Error(`render failed: ${r.stderr.slice(-400)}`);
  }
}
