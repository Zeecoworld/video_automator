import fs from "node:fs";
import type { Config } from "./config";
import { opt } from "./env";
import { log } from "./runtime";
import { transcribe as transcribeLocal, type Segment, type Word } from "./transcribe";

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // Groq's free tier accepts 25 MB per file

/** Spread a segment's words evenly over its duration (weighted by length) when a provider returns no word timestamps. */
export function wordsFromText(text: string, start: number, end: number): Word[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  let t = start;
  return parts.map((p) => {
    const d = ((p.length + 1) / total) * (end - start);
    const w = { start: t, end: t + d - 0.02, text: p };
    t += d;
    return w;
  });
}

interface VerboseJson {
  segments?: { start: number; end: number; text: string }[];
  words?: { word: string; start: number; end: number }[];
  text?: string;
}

/** OpenAI-style verbose_json (Groq, OpenAI, OpenRouter) -> segments with words. */
export function parseVerboseJson(j: VerboseJson): Segment[] {
  const words: Word[] = (j.words ?? []).map((w) => ({ start: Number(w.start), end: Number(w.end), text: String(w.word).trim() })).filter((w) => w.text);
  return (j.segments ?? [])
    .map((s) => {
      const start = Number(s.start), end = Number(s.end), text = String(s.text).trim();
      const own = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.1);
      return { start, end, text, words: own.length ? own : wordsFromText(text, start, end) };
    })
    .filter((s) => s.text);
}

/** Hugging Face ASR: { text, chunks: [{ text, timestamp: [start, end] }] } (segment level). */
export function parseHfAsr(j: { text?: string; chunks?: { text: string; timestamp: [number, number | null] }[] }): Segment[] {
  const chunks = (j.chunks ?? []).filter((c) => c.text?.trim());
  const segs = chunks.map((c, i) => {
    const start = Number(c.timestamp?.[0] ?? 0);
    const end = Number(c.timestamp?.[1] ?? chunks[i + 1]?.timestamp?.[0] ?? start + 4);
    const text = c.text.trim();
    return { start, end, text, words: wordsFromText(text, start, end) };
  });
  return segs;
}

export async function groqTranscribe(audioPath: string): Promise<Segment[]> {
  const size = fs.statSync(audioPath).size;
  if (size > MAX_UPLOAD_BYTES) throw new Error(`audio is ${(size / 1048576).toFixed(0)} MB; Groq accepts up to 25 MB per file`);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(fs.readFileSync(audioPath))], { type: "audio/mpeg" }), "audio.mp3");
  form.set("model", opt("GROQ_WHISPER_MODEL") ?? "whisper-large-v3-turbo");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (opt("WHISPER_LANGUAGE")) form.set("language", opt("WHISPER_LANGUAGE")!);
  const base = (opt("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opt("GROQ_API_KEY")}` },
    body: form,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!r.ok) throw new Error(`Groq transcription HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return parseVerboseJson((await r.json()) as VerboseJson);
}

/** Best effort: Hugging Face Inference Providers, whisper with segment timestamps. */
export async function hfTranscribe(audioPath: string): Promise<Segment[]> {
  const model = opt("HF_ASR_MODEL") ?? "openai/whisper-large-v3";
  const base = (opt("HF_ASR_BASE_URL") ?? "https://router.huggingface.co/hf-inference/models").replace(/\/$/, "");
  const r = await fetch(`${base}/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opt("HF_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: fs.readFileSync(audioPath).toString("base64"), parameters: { return_timestamps: true } }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!r.ok) throw new Error(`Hugging Face transcription HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const segs = parseHfAsr((await r.json()) as never);
  if (!segs.length) throw new Error("Hugging Face returned no timestamped text");
  return segs;
}

export type Transcriber = { name: string; run: (audioPath: string, cfg: Config) => Promise<Segment[]> };

/** Transcribers in the order they will be tried: TRANSCRIBERS=groq,huggingface,local, or whatever is configured. */
export function transcribers(env: NodeJS.ProcessEnv = process.env, canRunLocal = !(env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY)): Transcriber[] {
  const all: Record<string, Transcriber | null> = {
    groq: env.GROQ_API_KEY ? { name: "groq", run: groqTranscribe } : null,
    huggingface: env.HF_TOKEN ? { name: "huggingface", run: hfTranscribe } : null,
    local: canRunLocal && env.LOCAL_WHISPER !== "off" ? { name: "local", run: transcribeLocal } : null,
  };
  const order = (env.TRANSCRIBERS ?? "groq,huggingface,local").split(",").map((s) => s.trim().replace(/^hf$/, "huggingface"));
  return order.map((n) => all[n]).filter((t): t is Transcriber => Boolean(t));
}

/** Try each transcriber until one returns text. Throws with every failure listed if none does. */
export async function transcribeAny(audioPath: string, cfg: Config, list: Transcriber[] = transcribers()): Promise<{ segments: Segment[]; by: string }> {
  const errors: string[] = [];
  for (const t of list) {
    try {
      const segments = await t.run(audioPath, cfg);
      if (segments.length) {
        log.info(`Transcribed with ${t.name} (${segments.length} segments)`);
        return { segments, by: t.name };
      }
      errors.push(`${t.name}: no speech found`);
    } catch (e) {
      errors.push(`${t.name}: ${String((e as Error).message).slice(0, 160)}`);
      log.warn(`Transcriber ${t.name} failed; trying the next one`);
    }
  }
  throw new Error(list.length ? `all transcribers failed (${errors.join(" | ")})` : "no transcriber is configured (set GROQ_API_KEY or HF_TOKEN, or install Faster-Whisper)");
}
