import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { assetPath } from "./runtime";
import type { Silence } from "./types";

const onLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
let cachedBin: string | undefined;

/** Path to an executable ffmpeg. Zip extraction can drop the exec bit, so on Lambda we copy it to /tmp and chmod. */
export function ffmpegBin(): string {
  if (cachedBin) return cachedBin;
  const src = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);
  if (!src) throw new Error("ffmpeg binary not found (ffmpeg-static missing and FFMPEG_PATH unset)");
  if (!onLambda || process.env.FFMPEG_PATH) return (cachedBin = src);
  const dest = "/tmp/ffmpeg-bin";
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
  return (cachedBin = dest);
}

/** Minimal fontconfig so libass can find our bundled font even where the OS has none (Lambda). */
export function fontEnv(): { env: NodeJS.ProcessEnv; fontsDir: string } {
  const fontsDir = path.dirname(assetPath("assets/DejaVuSans-Bold.ttf"));
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "fc-"));
  const conf = path.join(dir, "fonts.conf");
  fs.writeFileSync(
    conf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${fontsDir}</dir><cachedir>${dir}</cachedir></fontconfig>`,
  );
  return { env: { ...process.env, FONTCONFIG_FILE: conf }, fontsDir };
}

export interface RunResult {
  code: number;
  stderr: string;
}

export function runFfmpeg(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-hide_banner", "-nostdin", ...args], { cwd: opts.cwd, env: opts.env ?? process.env });
    let stderr = "";
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 5_000_000) stderr = stderr.slice(-2_000_000);
    });
    const timer = opts.timeoutMs ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs) : undefined;
    p.on("error", reject);
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export const isHttp = (s: string) => /^https?:\/\//i.test(s);
const netArgs = (src: string) => (isHttp(src) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []);

// ---------------------------------------------------------------- parsing (pure)

export interface ProbeInfo {
  durationS: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export function parseProbe(stderr: string): ProbeInfo {
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = stderr.match(/Stream #\d+:\d+.*Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  return {
    durationS: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(stderr),
  };
}

export function parseSilences(stderr: string, durationS: number): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: durationS });
  return out;
}

// ---------------------------------------------------------------- operations

export async function probe(src: string): Promise<ProbeInfo> {
  const r = await runFfmpeg([...netArgs(src), "-i", src], { timeoutMs: 120_000 });
  const info = parseProbe(r.stderr);
  if (!info.durationS || !info.width) {
    throw new Error(`could not read video (${r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300)})`);
  }
  return info;
}

/** One pass: low-bitrate mono mp3 for Gemini, plus pause detection used to snap clip boundaries. */
export async function extractAudio(src: string, out: string, durationS: number): Promise<Silence[]> {
  const r = await runFfmpeg(
    [...netArgs(src), "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "24k",
      "-af", "silencedetect=noise=-32dB:d=0.4", "-y", out],
    { timeoutMs: 12 * 60_000 },
  );
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`audio extraction failed: ${r.stderr.slice(-300)}`);
  return parseSilences(r.stderr, durationS);
}
