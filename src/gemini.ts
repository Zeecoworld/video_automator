import { GoogleGenAI, Type, createPartFromUri, createUserContent } from "@google/genai";
import type { Config } from "./config";
import { req } from "./env";
import type { RawHighlight } from "./highlights";
import { log } from "./runtime";

const schema = {
  type: Type.OBJECT,
  properties: {
    clips: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER },
          endSeconds: { type: Type.NUMBER },
          headline: { type: Type.STRING },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
          score: { type: Type.INTEGER },
        },
        required: ["startSeconds", "endSeconds", "headline", "title", "description", "hashtags", "score"],
      },
    },
  },
  required: ["clips"],
};

export function buildPrompt(title: string, durationS: number, n: number, minS: number, maxS: number): string {
  return `You are an expert short-form video editor for YouTube Shorts and TikTok.
The attached audio is from a long video titled "${title}" that is ${Math.round(durationS)} seconds long.
Listen to it and pick up to ${n} clips. Every clip MUST:
1. Be between ${minS} and ${maxS} seconds long (endSeconds minus startSeconds).
2. Start at the very beginning of a sentence and end right after a sentence finishes. Never cut mid-sentence or mid-word.
3. Be fully self-contained: a viewer who has not seen the rest of the video must understand it.
4. Open with a strong hook in the first 3 seconds (bold claim, question, surprise or payoff).
5. Not overlap any other clip.
Prefer insight, surprise, strong opinions, concrete tips and emotional moments over intros and filler.
startSeconds and endSeconds are seconds from the very start of the audio (plain numbers, e.g. 754.5).
For each clip also write: headline (punchy on-screen hook, max 7 words, no emoji), title (max 90 characters, no hashtags),
description (1-2 sentences, max 280 characters), hashtags (3-5, without the # symbol), score (1-100 viral potential).
If the audio has no clear speech, return clips at natural scene or section changes.`;
}

/** Accepts numbers, numeric strings and "MM:SS" / "HH:MM:SS" just in case the model ignores the schema. */
export function toSeconds(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const p = s.split(":").map(Number);
  if (p.length >= 2 && p.every(Number.isFinite)) return p.reduce((acc, x) => acc * 60 + x, 0);
  return NaN;
}

export function parsePlan(text: string): RawHighlight[] {
  const data = JSON.parse(text) as { clips?: Record<string, unknown>[] };
  return (data.clips ?? []).map((c) => ({
    startS: toSeconds(c.startSeconds),
    endS: toSeconds(c.endSeconds),
    headline: String(c.headline ?? ""),
    title: String(c.title ?? ""),
    description: String(c.description ?? ""),
    hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
    score: Number(c.score ?? 50),
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function planClips(
  audioPath: string, title: string, durationS: number, nMax: number, cfg: Config,
): Promise<RawHighlight[]> {
  const ai = new GoogleGenAI({ apiKey: req("GEMINI_API_KEY") });
  const file = await ai.files.upload({ file: audioPath, config: { mimeType: "audio/mp3" } });
  try {
    for (let i = 0; i < 30 && file.name; i++) {
      const f = await ai.files.get({ name: file.name });
      if (String(f.state) === "ACTIVE" || !f.state) break;
      if (String(f.state) === "FAILED") throw new Error("Gemini could not process the audio file");
      await sleep(2000);
    }
    const prompt = buildPrompt(title, durationS, nMax, cfg.clip.minS, cfg.clip.maxS);
    let last: unknown;
    for (const model of cfg.gemini.models) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const resp = await ai.models.generateContent({
            model,
            contents: createUserContent([createPartFromUri(file.uri!, file.mimeType!), prompt]),
            config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 },
          });
          return parsePlan(resp.text ?? "{}");
        } catch (e) {
          last = e;
          const msg = String((e as Error)?.message ?? e).toLowerCase();
          if (/429|503|500|resource_exhausted|unavailable|overloaded|deadline/.test(msg)) {
            const delay = Math.min(60_000, 5000 * 2 ** attempt);
            log.warn(`Gemini ${model} transient error; retry in ${delay / 1000}s`);
            await sleep(delay);
            continue;
          }
          log.warn(`Gemini ${model} failed: ${msg.slice(0, 200)}`);
          break;
        }
      }
    }
    throw new Error(`all Gemini models failed: ${String((last as Error)?.message ?? last).slice(0, 200)}`);
  } finally {
    if (file.name) await ai.files.delete({ name: file.name }).catch(() => undefined);
  }
}
