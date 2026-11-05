import { spawn } from "node:child_process";
import type { Config } from "./config";
import { opt } from "./env";
import { assetPath, log } from "./runtime";
import type { Cap } from "./types";

export interface Word {
  start: number;
  end: number;
  text: string;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

/** Parse the JSON printed by worker/transcribe.py. */
export function parseTranscript(stdout: string): Segment[] {
  const j = JSON.parse(stdout) as { segments?: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }[] };
  return (j.segments ?? []).map((s) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text).trim(),
    words: (s.words ?? []).map((w) => ({ start: Number(w.start), end: Number(w.end), text: String(w.word).trim() })).filter((w) => w.text),
  }));
}

/** Split Whisper segments at sentence punctuation so clips begin and end on complete thoughts. */
export function toSentences(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (!seg.words.length) { out.push(seg); continue; }
    let cur: Word[] = [];
    const flush = () => {
      if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" "), words: cur });
      cur = [];
    };
    for (const w of seg.words) {
      cur.push(w);
      if (/[.?!…]$/.test(w.text)) flush();
    }
    flush();
  }
  return out;
}

export function wordsBetween(sentences: Segment[], start: number, end: number): Cap[] {
  return sentences
    .flatMap((s) => s.words)
    .filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05)
    .map((w) => ({ s: w.start, e: w.end, t: w.text }));
}

export const wordCount = (segs: Segment[]) => segs.reduce((n, s) => n + s.words.length, 0);

export function pythonBin(): string {
  return opt("PYTHON_BIN") ?? (process.platform === "win32" ? "python" : "python3");
}

/** Run Faster-Whisper (Python) on an audio file. The model downloads on first use and is cached. */
export function transcribe(audioPath: string, cfg: Config): Promise<Segment[]> {
  const script = opt("TRANSCRIBE_SCRIPT") ?? assetPath("worker/transcribe.py");
  log.info(`Transcribing with Faster-Whisper (${cfg.whisper.model})`);
  return new Promise((resolve, reject) => {
    const p = spawn(pythonBin(), [script, audioPath, cfg.whisper.model], { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    p.on("error", (e) => reject(new Error(`could not start ${pythonBin()} (${e.message}). Install Python and run: pip install faster-whisper`)));
    p.on("close", (code) => {
      if (code !== 0) {
        const hint = /No module named 'faster_whisper'/.test(err) ? "Faster-Whisper is not installed: run pip install faster-whisper" : err.trim().split("\n").pop();
        return reject(new Error(`transcription failed: ${hint}`));
      }
      try {
        resolve(parseTranscript(out));
      } catch {
        reject(new Error("transcription returned invalid output"));
      }
    });
  });
}
