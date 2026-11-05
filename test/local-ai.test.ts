import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config";
import { aiProvider } from "../src/env";
import { ffmpegBin, probe } from "../src/ffmpeg";
import { buildLlmPrompt, extractJson, heuristicHighlights, keywords, llmHighlights, parseLlmClips, snapToSentences } from "../src/highlights-local";
import { analyzeSource } from "../src/pipeline";
import { buildHeadlineAss, captionChunks, renderClip } from "../src/render";
import { parseTranscript, toSentences, transcribe, wordsBetween } from "../src/transcribe";

const FAKE = path.join(__dirname, "fixtures/fake_transcribe.py");
const PY = process.platform === "win32" ? "python" : "python3";
const ENVS = ["AI_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "TRANSCRIBE_SCRIPT", "PYTHON_BIN", "GEMINI_API_KEY", "GROQ_API_KEY", "HF_TOKEN", "HF_MODEL", "TRANSCRIBERS", "TEXT_MODELS"];
const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENVS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); });

async function fakeSentences() {
  process.env.TRANSCRIBE_SCRIPT = FAKE;
  process.env.PYTHON_BIN = PY;
  return toSentences(await transcribe("ignored.mp3", defaultConfig));
}

describe("Faster-Whisper bridge", () => {
  it("runs the script, parses segments and splits sentences", async () => {
    const sents = await fakeSentences();
    expect(sents).toHaveLength(14);
    expect(sents[0].text).toBe("Why do most people fail at learning Python?");
    expect(sents[1].start).toBe(5);
    expect(wordsBetween(sents, 5, 10).map((w) => w.t).slice(0, 3)).toEqual(["They", "jump", "between"]);
  });
  it("explains a missing Python or a failing script", async () => {
    process.env.PYTHON_BIN = "definitely-not-python";
    await expect(transcribe("a.mp3", defaultConfig)).rejects.toThrow(/pip install faster-whisper/);
    process.env.PYTHON_BIN = PY;
    process.env.TRANSCRIBE_SCRIPT = path.join(__dirname, "fixtures/missing.py");
    await expect(transcribe("a.mp3", defaultConfig)).rejects.toThrow(/transcription failed/);
  });
  it("parses transcript JSON and keeps unpunctuated segments whole", () => {
    const segs = parseTranscript(JSON.stringify({ segments: [{ start: 0, end: 2, text: " hi there ", words: [{ start: 0, end: 1, word: "hi" }, { start: 1, end: 2, word: "there" }] }] }));
    expect(toSentences(segs)).toHaveLength(1);
  });
});

describe("rule-based picker (no AI, no API)", () => {
  it("chooses in-range, non-overlapping, sentence-aligned clips with text from the transcript", async () => {
    const sents = await fakeSentences();
    const out = heuristicHighlights(sents, 70, defaultConfig, 3);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const h of out) {
      expect(h.endS - h.startS).toBeGreaterThanOrEqual(20);
      expect(h.endS - h.startS).toBeLessThanOrEqual(60);
      expect(h.title.length).toBeGreaterThan(5);
      expect(h.headline.split(" ").length).toBeLessThanOrEqual(7);
      expect(h.hashtags).toContain("shorts");
    }
    out.slice(1).forEach((h, i) => expect(h.startS).toBeGreaterThanOrEqual(out[i].endS - 0.5));
    const first = out[0];
    expect(sents.some((s) => Math.abs(s.start - first.startS) <= 0.16)).toBe(true); // starts on a sentence (minus a 0.15s lead-in)
  });
  it("extracts keywords without stop words", () => {
    expect(keywords("Python projects teach Python faster than tutorials, projects beat tutorials", 2)).toEqual(["projects", "python"]);
  });
});

describe("text-model picker (OpenAI-compatible)", () => {
  it("extracts JSON from fenced or chatty replies and tolerant field names", () => {
    expect(extractJson('Sure!\n```json\n{"clips":[{"start":1,"end":30}]}\n```\nHope it helps')).toEqual({ clips: [{ start: 1, end: 30 }] });
    const [c] = parseLlmClips('{"clips":[{"startSeconds":"5.0","end_s":40,"headline":"h","title":"t","description":"d","hashtags":["a"],"score":9}]}');
    expect([c.startS, c.endS]).toEqual([5, 40]);
    expect(() => extractJson("no json here")).toThrow();
  });
  it("snaps model timestamps to sentence boundaries", async () => {
    const sents = await fakeSentences();
    const raw = [{ startS: 6.1, endS: 47, headline: "Finish projects", title: "T", description: "D", hashtags: ["python"], score: 90 }];
    const [h] = snapToSentences(raw, sents, 70, 20, 59, 3);
    expect(h.startS).toBeCloseTo(5 - 0.15, 5);
    expect(h.endS - h.startS).toBeLessThanOrEqual(60);
  });
  it("calls the configured chat endpoint and falls back when response_format is rejected", async () => {
    const sents = await fakeSentences();
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const body = JSON.parse(b);
        bodies.push({ auth: req.headers.authorization, body });
        if (body.response_format) { res.writeHead(400); return res.end("response_format unsupported"); }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"clips":[{"start":5,"end":40,"headline":"Finish projects","title":"Finish small projects","description":"Why finishing beats watching.","hashtags":["python"],"score":88}]}\n```' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    process.env.LLM_MODEL = "test-model";
    process.env.LLM_API_KEY = "k";
    try {
      const out = await llmHighlights(sents, "Learn Python", 70, defaultConfig, 3);
      expect(out).toHaveLength(1);
      expect(out[0].title).toBe("Finish small projects");
      expect(bodies[0].auth).toBe("Bearer k");
      expect(bodies[0].body.model).toBe("test-model");
      expect(bodies.at(-1).body.response_format).toBeUndefined();
      expect(buildLlmPrompt("T", sents, defaultConfig, 3)).toMatch(/\[0\.0-4\.[34]\] Why do most people fail/);
    } finally { server.close(); }
  });
});

describe("subtitles", () => {
  it("groups words into short chunks and writes them relative to the clip start", () => {
    const words = Array.from({ length: 9 }, (_, i) => ({ s: 10 + i * 0.4, e: 10.35 + i * 0.4, t: `w${i}` }));
    expect(captionChunks(words).map((c) => c.length)).toEqual([4, 4, 1]);
    const ass = buildHeadlineAss("Hello", 1080, 1920, defaultConfig, 20, words, 10);
    const caps = ass.split("\n").filter((l) => l.includes(",Cap,"));
    expect(caps).toHaveLength(3);
    expect(caps[0]).toMatch(/^Dialogue: 0,0:00:00\.00,.*W0 W1 W2 W3$/);
    expect(ass).toContain("Style: Cap,");
  });
});

describe("provider selection", () => {
  it("defaults to the auto chain; the Gemini-only path only when asked", () => {
    for (const k of ENVS) delete process.env[k];
    expect(aiProvider()).toBe("auto");
    process.env.GEMINI_API_KEY = "x";
    expect(aiProvider()).toBe("auto");
    process.env.AI_PROVIDER = "local";
    expect(aiProvider()).toBe("auto");
    process.env.AI_PROVIDER = "gemini";
    expect(aiProvider()).toBe("gemini");
  });
});

describe("end to end with the local pipeline (stub transcript, real ffmpeg)", () => {
  let dir: string, src: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-"));
    src = path.join(dir, "talk.mp4");
    execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=70",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=70", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
  }, 120_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("transcribes, picks moments, attaches words, and renders vertical clips with captions", async () => {
    process.env.AI_PROVIDER = "local";
    process.env.TRANSCRIBE_SCRIPT = FAKE;
    process.env.PYTHON_BIN = PY;
    const plan = await analyzeSource({ id: "s", platform: "youtube", url: "https://x/y.mp4", title: null, variants: ["pad"] } as never, src, defaultConfig, 3, "Learn Python");
    expect(plan.highlights.length).toBeGreaterThanOrEqual(2);
    expect(plan.highlights.every((h) => (h.words?.length ?? 0) > 20)).toBe(true);
    const out = path.join(dir, "c.mp4");
    await renderClip({ srcUrl: src, hasAudio: true, out, workdir: path.join(dir, "w"), h: plan.highlights[0], variant: "pad",
      cfg: { ...defaultConfig, render: { ...defaultConfig.render, width: 720, height: 1280 } } });
    const info = await probe(out);
    expect([info.width, info.height]).toEqual([720, 1280]);
    expect(info.durationS).toBeGreaterThan(19);
  }, 180_000);

  it("a 9-second video becomes one clip with words and text from its transcript", async () => {
    const tiny = path.join(dir, "tiny.mp4");
    execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=9",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=9", "-c:v", "libx264", "-c:a", "aac", "-shortest", tiny]);
    process.env.AI_PROVIDER = "local";
    process.env.TRANSCRIBE_SCRIPT = FAKE;
    process.env.PYTHON_BIN = PY;
    const plan = await analyzeSource({ id: "s", platform: "youtube", url: "https://x/z", title: null, variants: ["pad"] } as never, tiny, defaultConfig, 3, "Short");
    expect(plan.highlights).toHaveLength(1);
    expect(plan.highlights[0].title).toBe("Why do most people fail at learning Python?");
    expect(plan.highlights[0].words!.length).toBeGreaterThan(5);
  }, 120_000);
});
