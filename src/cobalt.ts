import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config";
import { opt, req } from "./env";
import { SourceSkip } from "./errors";
import { titleFromUrl } from "./highlights";
import { log } from "./runtime";
import type { Download } from "./ytdlp";

export function friendlyCobaltError(code: string): string {
  const c = code.toLowerCase();
  if (c.includes("auth")) return "Cobalt rejected the API key. Check COBALT_API_KEY against your instance's auth settings.";
  if (c.includes("rate")) return "Cobalt rate limit reached; it will retry on the next run.";
  if (c.includes("private")) return "The video is private.";
  if (c.includes("age")) return "The video is age-restricted and needs a logged-in session on your Cobalt instance.";
  if (c.includes("login")) return "YouTube asked your Cobalt instance to sign in. See the Cobalt docs on YouTube cookies / session tokens.";
  if (c.includes("unavailable") || c.includes("empty") || c.includes("not_found")) return "The video is unavailable, removed, or not public.";
  if (c.includes("unsupported")) return "Cobalt does not support this link.";
  return `Cobalt error: ${code}`;
}

/** Turn Cobalt's JSON answer into a file URL, or a clear error. */
export function interpret(j: unknown): { url: string; filename?: string } {
  const r = j as { status?: string; url?: string; filename?: string; picker?: { type: string; url: string }[]; error?: { code?: string } };
  switch (r?.status) {
    case "tunnel":
    case "redirect":
      if (!r.url) throw new Error("Cobalt returned no URL");
      return { url: r.url, filename: r.filename };
    case "picker": {
      const v = (r.picker ?? []).find((p) => p.type === "video" || p.type === "gif");
      if (!v) throw new SourceSkip("this post contains only photos");
      return { url: v.url };
    }
    case "local-processing":
      throw new Error("Cobalt wants the client to remux this video. Set FORCE_LOCAL_PROCESSING=never on your Cobalt instance.");
    case "error":
      throw new Error(friendlyCobaltError(r.error?.code ?? "unknown"));
    default:
      throw new Error(`unexpected Cobalt response: ${JSON.stringify(j).slice(0, 200)}`);
  }
}

async function resolve(url: string, cfg: Config): Promise<{ url: string; filename?: string }> {
  const base = req("COBALT_API_URL");
  const key = opt("COBALT_API_KEY");
  const r = await fetch(base, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(key ? { Authorization: `Api-Key ${key}` } : {}) },
    body: JSON.stringify({ url, videoQuality: cfg.download.quality, downloadMode: "auto", filenameStyle: "basic" }),
  });
  const text = await r.text();
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`Cobalt returned HTTP ${r.status} (not JSON): ${text.slice(0, 120)}`);
  }
  return interpret(j);
}

/** Best-effort title (helps Gemini). Cobalt itself does not return one. */
async function titleFor(url: string): Promise<string> {
  if (/youtu\.?be/.test(url)) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return String(((await r.json()) as { title?: string }).title ?? "").trim().slice(0, 150) || titleFromUrl(url);
    } catch {
      /* ignore */
    }
  }
  return titleFromUrl(url);
}

export async function downloadViaCobalt(url: string, dir: string, cfg: Config): Promise<Download> {
  const file = await resolve(url, cfg);
  const maxBytes = cfg.download.maxMb * 1024 * 1024;
  const res = await fetch(file.url);
  if (!res.ok || !res.body) throw new Error(`Cobalt download link failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  const tooBig = (mb: number) =>
    new SourceSkip(`video is over ${mb.toFixed(0)} MB, the limit is ${cfg.download.maxMb} MB. Lower COBALT_QUALITY (e.g. 480) or raise MAX_DOWNLOAD_MB.`);
  if (len > maxBytes) throw tooBig(len / 1048576);

  const ext = path.extname(file.filename ?? "").toLowerCase() || ".mp4";
  const out = path.join(dir, `source${ext}`);
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(tooBig(seen / 1048576));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(out));
  } catch (e) {
    fs.rmSync(out, { force: true });
    throw e;
  }
  if (fs.statSync(out).size < 10_000) throw new Error("Cobalt delivered an empty file");
  const title = await titleFor(url);
  log.info(`Downloaded "${title}" via Cobalt (${(seen / 1048576).toFixed(0)} MB)`);
  return { path: out, title, durationS: 0 };
}
