import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { opt } from "./env";
import { SourceSkip } from "./errors";
import { log } from "./runtime";

export interface Download {
  path: string;
  title: string;
  durationS: number;
}

const bin = () => opt("YTDLP_PATH") ?? "yt-dlp";

function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin(), args, { env: process.env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-20_000); });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(new Error(`could not start yt-dlp (${e.message}). Is it installed?`)); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** Turn yt-dlp's raw error into something you can act on. */
export function friendlyError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("confirm you’re not a bot") || s.includes("confirm you're not a bot") || s.includes("sign in to confirm"))
    return "YouTube blocked this server as a bot. Add a YTDLP_COOKIES secret (cookies.txt exported while logged in) or use a self-hosted runner.";
  if (s.includes("login required") || s.includes("rate-limit reached or login required") || s.includes("instagram") && s.includes("login"))
    return "Instagram needs a logged-in session. Add a YTDLP_COOKIES secret (cookies.txt exported from a logged-in browser).";
  if (s.includes("private video") || s.includes("this video is private")) return "The video is private.";
  if (s.includes("video unavailable") || s.includes("has been removed")) return "The video is unavailable or removed.";
  if (s.includes("http error 403")) return "Download blocked (HTTP 403). Cookies or a different network may be needed.";
  const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "unknown error";
  return `yt-dlp failed: ${last.slice(0, 300)}`;
}

export function parseInfo(stdout: string): { title: string; durationS: number } {
  const j = JSON.parse(stdout) as { title?: string; duration?: number; fulltitle?: string; description?: string };
  const title = (j.title || j.fulltitle || j.description?.split("\n")[0] || "Clip").trim().slice(0, 150);
  return { title, durationS: Number(j.duration ?? 0) };
}

export async function downloadVideo(url: string, dir: string, cfg: Config): Promise<Download> {
  const common = ["--no-playlist", "--no-warnings", "--no-progress", "--retries", "5", "--fragment-retries", "5"];
  const cookies = opt("YTDLP_COOKIES_FILE");
  if (cookies && fs.existsSync(cookies)) common.push("--cookies", cookies);
  const proxy = opt("YTDLP_PROXY"); // e.g. a residential proxy, if YouTube/Instagram block your server's IP
  if (proxy) common.push("--proxy", proxy);

  const meta = await run([...common, "-J", "--skip-download", url], 5 * 60_000);
  if (meta.code !== 0) throw new Error(friendlyError(meta.stderr));
  const info = parseInfo(meta.stdout);
  if (info.durationS && info.durationS > cfg.maxSourceMinutes * 60) {
    throw new SourceSkip(`video is ${(info.durationS / 60).toFixed(0)} min, limit is ${cfg.maxSourceMinutes}`);
  }

  log.info(`Downloading "${info.title}" (${(info.durationS / 60).toFixed(1)} min)`);
  const outTpl = path.join(dir, "source.%(ext)s");
  const dl = await run(
    [...common, "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "-o", outTpl, url],
    40 * 60_000,
  );
  if (dl.code !== 0) throw new Error(friendlyError(dl.stderr));
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("source.")).sort((a, b) => Number(b.endsWith(".mp4")) - Number(a.endsWith(".mp4")));
  if (!files.length) throw new Error("download finished but no file was produced");
  return { path: path.join(dir, files[0]), title: info.title, durationS: info.durationS };
}
