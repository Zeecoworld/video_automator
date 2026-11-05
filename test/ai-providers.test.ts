import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config";
import { llmHighlights, textProviders, type TextProvider } from "../src/highlights-local";
import type { Segment } from "../src/transcribe";
import { groqTranscribe, hfTranscribe, parseHfAsr, parseVerboseJson, transcribeAny, transcribers, wordsFromText } from "../src/transcribe-api";

const KEYS = ["GROQ_API_KEY", "GROQ_BASE_URL", "GROQ_MODEL", "HF_TOKEN", "HF_MODEL", "HF_ASR_BASE_URL", "GEMINI_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "TRANSCRIBERS", "TEXT_MODELS", "LOCAL_WHISPER"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); });

const audio = path.join(os.tmpdir(), "ai-providers-test.mp3");
fs.writeFileSync(audio, Buffer.from("ID3fakeaudio"));

async function server(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const seen: { url?: string; auth?: string; body: string }[] = [];
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => { seen.push({ url: req.url, auth: req.headers.authorization, body: b }); handler(req, b, res); });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen, close: () => s.close() };
}

describe("word timing helpers", () => {
  it("spreads words over the segment in order", () => {
    const w = wordsFromText("one two three", 10, 13);
    expect(w).toHaveLength(3);
    expect(w[0].start).toBe(10);
    expect(w[2].end).toBeLessThanOrEqual(13);
    w.slice(1).forEach((x, i) => expect(x.start).toBeGreaterThanOrEqual(w[i].end));
  });
  it("assigns provider words to segments, and synthesises them when missing", () => {
    const segs = parseVerboseJson({
      segments: [{ start: 0, end: 4, text: "Hello there." }, { start: 4, end: 8, text: "Second one here." }],
      words: [{ word: "Hello", start: 0.1, end: 0.5 }, { word: "there.", start: 0.6, end: 1 }],
    });
    expect(segs[0].words.map((w) => w.text)).toEqual(["Hello", "there."]);
    expect(segs[1].words.map((w) => w.text)).toEqual(["Second", "one", "here."]); // synthesised
  });
  it("reads Hugging Face chunks", () => {
    const segs = parseHfAsr({ chunks: [{ text: " First sentence. ", timestamp: [0, 3.2] }, { text: "Second.", timestamp: [3.2, null] }] });
    expect(segs.map((s) => [s.start, s.end, s.text])).toEqual([[0, 3.2, "First sentence."], [3.2, 7.2, "Second."]]);
  });
});

describe("Groq transcription", () => {
  it("posts the audio with word+segment timestamps and parses the answer", async () => {
    const s = await server((_r, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "Hi there.", segments: [{ start: 0, end: 2, text: "Hi there." }], words: [{ word: "Hi", start: 0, end: 0.5 }, { word: "there.", start: 0.6, end: 1.2 }] }));
    });
    process.env.GROQ_API_KEY = "gk";
    process.env.GROQ_BASE_URL = s.url + "/openai/v1";
    try {
      const segs = await groqTranscribe(audio);
      expect(segs[0].words).toHaveLength(2);
      expect(s.seen[0].url).toBe("/openai/v1/audio/transcriptions");
      expect(s.seen[0].auth).toBe("Bearer gk");
      expect(s.seen[0].body).toContain("whisper-large-v3-turbo");
      expect(s.seen[0].body).toContain("verbose_json");
      expect(s.seen[0].body.match(/timestamp_granularities\[\]/g)).toHaveLength(2);
    } finally { s.close(); }
  });
  it("explains HTTP errors", async () => {
    const s = await server((_r, _b, res) => { res.writeHead(429); res.end("rate limited"); });
    process.env.GROQ_API_KEY = "gk";
    process.env.GROQ_BASE_URL = s.url;
    try { await expect(groqTranscribe(audio)).rejects.toThrow(/HTTP 429/); } finally { s.close(); }
  });
});

describe("Hugging Face transcription (best effort)", () => {
  it("sends base64 audio with return_timestamps", async () => {
    const s = await server((_r, _b, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: "x", chunks: [{ text: "Hello world.", timestamp: [0, 2] }] })); });
    process.env.HF_TOKEN = "hf_x";
    process.env.HF_ASR_BASE_URL = s.url + "/hf-inference/models";
    try {
      const segs = await hfTranscribe(audio);
      expect(segs[0].text).toBe("Hello world.");
      const sent = JSON.parse(s.seen[0].body);
      expect(sent.parameters).toEqual({ return_timestamps: true });
      expect(Buffer.from(sent.inputs, "base64").toString()).toBe("ID3fakeaudio");
      expect(s.seen[0].url).toBe("/hf-inference/models/openai/whisper-large-v3");
    } finally { s.close(); }
  });
});

describe("transcriber chain", () => {
  it("orders by configuration and only includes what is available", () => {
    expect(transcribers({}, true).map((t) => t.name)).toEqual(["local"]);
    expect(transcribers({}, false)).toEqual([]);
    expect(transcribers({ GROQ_API_KEY: "a", HF_TOKEN: "b" }, true).map((t) => t.name)).toEqual(["groq", "huggingface", "local"]);
    expect(transcribers({ GROQ_API_KEY: "a", TRANSCRIBERS: "local,groq" }, true).map((t) => t.name)).toEqual(["local", "groq"]);
    expect(transcribers({ LOCAL_WHISPER: "off" }, true)).toEqual([]);
  });
  it("falls through to the next transcriber and reports every failure when none works", async () => {
    const seg: Segment[] = [{ start: 0, end: 1, text: "hi", words: [] }];
    const ok = await transcribeAny("a.mp3", defaultConfig, [
      { name: "groq", run: async () => { throw new Error("429"); } },
      { name: "local", run: async () => seg },
    ]);
    expect(ok.by).toBe("local");
    await expect(transcribeAny("a.mp3", defaultConfig, [
      { name: "groq", run: async () => { throw new Error("429"); } },
      { name: "huggingface", run: async () => [] },
    ])).rejects.toThrow(/groq: 429.*huggingface: no speech/);
    await expect(transcribeAny("a.mp3", defaultConfig, [])).rejects.toThrow(/no transcriber is configured/);
  });
});

describe("text model chain", () => {
  it("orders providers by configuration", () => {
    expect(textProviders({})).toEqual([]);
    const p = textProviders({ GROQ_API_KEY: "g", GEMINI_API_KEY: "m", HF_TOKEN: "h", HF_MODEL: "org/model", LLM_BASE_URL: "http://x/v1", LLM_MODEL: "m1" });
    expect(p.map((x) => x.name)).toEqual(["groq", "gemini", "huggingface", "custom"]);
    expect(p[0].base).toBe("https://api.groq.com/openai/v1");
    expect(p[1].base).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(textProviders({ GROQ_API_KEY: "g", HF_TOKEN: "h" }).map((x) => x.name)).toEqual(["groq"]); // HF needs HF_MODEL
    expect(textProviders({ GROQ_API_KEY: "g", GEMINI_API_KEY: "m", TEXT_MODELS: "gemini,groq" }).map((x) => x.name)).toEqual(["gemini", "groq"]);
  });

  it("moves on to the next provider when one fails", async () => {
    const sents: Segment[] = Array.from({ length: 12 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: `Sentence number ${i}.`, words: [] }));
    const bad = await server((_r, _b, res) => { res.writeHead(401); res.end("bad key"); });
    const good = await server((_r, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"clips":[{"start":0,"end":29.5,"headline":"H","title":"Second provider wins","description":"D","hashtags":["x"],"score":90}]}' } }] }));
    });
    const providers: TextProvider[] = [
      { name: "groq", base: bad.url, key: "k", model: "m" },
      { name: "custom", base: good.url, key: "k", model: "m" },
    ];
    try {
      const out = await llmHighlights(sents, "T", 60, defaultConfig, 3, providers);
      expect(out[0].title).toBe("Second provider wins");
      expect(bad.seen.length).toBeGreaterThan(0);
      await expect(llmHighlights(sents, "T", 60, defaultConfig, 3, [providers[0]])).rejects.toThrow(/groq/);
    } finally { bad.close(); good.close(); }
  }, 60_000);
});
