import type { Config } from "./config";
import { opt } from "./env";
import { cleanHighlight, type RawHighlight } from "./highlights";
import { log } from "./runtime";
import type { Segment } from "./transcribe";
import type { Highlight } from "./types";

const STOP = new Set(("about after again also always another because been before being between both could does doing down each even every from gonna have having here into just kind know like lots made make many more most much must never only other over really right said same should since some something still such take than that their them then there these they thing things think this those through today very want well were what when where which while will with would your you're it's don't that's there's they're we're going actually basically literally maybe people").split(" "));
const HOOK_START = /^(how|why|what|stop|never|secret|mistake|truth|this|here's|imagine|nobody|everyone|everybody|most|if you|the biggest|the best|the worst|you|don't|do you|did you|let me)\b/i;
const CONTINUATION = /^(and|but|so|because|also|then|which|that|or|plus|anyway|well|yeah|okay|ok)\b/i;

const terminal = (t: string) => /[.?!…]["')\]]*$/.test(t.trim());
const sentenceCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const tidy = (t: string) => t.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- metadata from text (no AI needed)

export function keywords(text: string, n = 3): string[] {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}']{5,}/gu) ?? []) {
    if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w.replace(/'/g, ""));
}

export function metaFromSentences(sents: Segment[]): Pick<Highlight, "headline" | "title" | "description" | "hashtags"> {
  const first = tidy(sents[0]?.text ?? "").replace(/[.!…]+$/, "");
  const all = sents.map((s) => tidy(s.text)).join(" ");
  const headline = first.split(" ").slice(0, 7).join(" ").replace(/[,;:]+$/, "");
  const title = sentenceCase(first).slice(0, 90);
  const description = tidy(sents.slice(0, 2).map((s) => s.text).join(" ")).slice(0, 280);
  return { headline: headline || "Watch this", title: title || "Clip", description, hashtags: [...keywords(all), "shorts"].slice(0, 5) };
}

// ---------------------------------------------------------------- rule-based picker (free, offline)

function scoreWindow(sents: Segment[]): number {
  const first = sents[0];
  const text = tidy(first.text);
  const nWords = first.words.length || text.split(" ").length;
  let s = 0;
  if (/\?/.test(text)) s += 2;
  if (HOOK_START.test(text)) s += 1.5;
  if (/\d/.test(text)) s += 1;
  if (/!/.test(text)) s += 0.5;
  if (nWords >= 4 && nWords <= 18) s += 1;
  if (CONTINUATION.test(text)) s -= 3;
  const dur = sents[sents.length - 1].end - first.start;
  const words = sents.reduce((n, x) => n + (x.words.length || x.text.split(" ").length), 0);
  const rate = words / Math.max(dur, 1);
  s += rate >= 2 && rate <= 3.8 ? 2 : Math.max(0, 2 - Math.abs(rate - 2.9));
  for (let i = 1; i < sents.length; i++) if (sents[i].start - sents[i - 1].end > 1.5) s -= 0.5;
  if (terminal(sents[sents.length - 1].text)) s += 1;
  const uniq = new Set(sents.flatMap((x) => x.text.toLowerCase().split(/\W+/)).filter(Boolean)).size;
  s += Math.min(1, uniq / Math.max(words, 1));
  s += 1 - Math.min(1, Math.abs(dur - 40) / 30);
  return s;
}

/** Slide over complete sentences, score each window on hook, pace, completeness and variety; keep the best that do not overlap. */
export function heuristicHighlights(sentences: Segment[], durationS: number, cfg: Config, nMax: number): Highlight[] {
  const { minS, maxS } = cfg.clip;
  const cands: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < sentences.length; i++) {
    let best: { j: number; score: number } | null = null;
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j].end - sentences[i].start;
      if (dur > maxS) break;
      if (dur < minS) continue;
      const sc = scoreWindow(sentences.slice(i, j + 1));
      if (!best || sc > best.score) best = { j, score: sc };
    }
    if (best) cands.push({ i, ...best });
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen: typeof cands = [];
  for (const c of cands) {
    const a = sentences[c.i].start, b = sentences[c.j].end;
    if (chosen.every((x) => b <= sentences[x.i].start || a >= sentences[x.j].end)) chosen.push(c);
    if (chosen.length >= nMax) break;
  }
  return chosen
    .sort((a, b) => sentences[a.i].start - sentences[b.i].start)
    .map((c) => {
      const win = sentences.slice(c.i, c.j + 1);
      return cleanHighlight({
        startS: Math.max(0, win[0].start - 0.15),
        endS: Math.min(durationS, win[win.length - 1].end + 0.35),
        ...metaFromSentences(win),
        score: Math.round(Math.min(100, Math.max(1, c.score * 12))),
      });
    });
}

// ---------------------------------------------------------------- snapping to sentence boundaries

/** Snap model timestamps to real sentence starts/ends, enforce length limits, drop overlaps. */
export function snapToSentences(raw: RawHighlight[], sentences: Segment[], durationS: number, minS: number, maxS: number, limit: number): Highlight[] {
  if (!sentences.length) return [];
  const last = sentences.length - 1;
  const nearest = (vals: number[], t: number) => vals.reduce((bi, v, k) => (Math.abs(v - t) < Math.abs(vals[bi] - t) ? k : bi), 0);
  const starts = sentences.map((s) => s.start), ends = sentences.map((s) => s.end);
  const cands: Highlight[] = [];
  for (const h of raw) {
    if (!Number.isFinite(h.startS) || !Number.isFinite(h.endS)) continue;
    const i = nearest(starts, h.startS);
    let j = nearest(ends, h.endS);
    if (j < i) continue;
    while (j > i && ends[j] - starts[i] > maxS) j--;
    while (j < last && ends[j] - starts[i] < minS && ends[j + 1] - starts[i] <= maxS) j++;
    const d = ends[j] - starts[i];
    if (d < minS || d > maxS) continue;
    cands.push(cleanHighlight({ ...h, startS: Math.max(0, starts[i] - 0.15), endS: Math.min(durationS, ends[j] + 0.35) }));
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen: Highlight[] = [];
  for (const h of cands) {
    if (chosen.every((c) => h.endS <= c.startS || h.startS >= c.endS)) chosen.push(h);
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.startS - b.startS);
}

// ---------------------------------------------------------------- text-model picker (any OpenAI-compatible API)

export interface TextProvider {
  name: string;
  base: string;
  key?: string;
  model: string;
}

/**
 * Text models that can choose the moments, in the order they will be tried. Every one speaks the OpenAI chat format.
 * Order: TEXT_MODELS=groq,gemini,huggingface,custom (default). A provider is used only when its key/model is set.
 */
export function textProviders(env: NodeJS.ProcessEnv = process.env): TextProvider[] {
  const all: Record<string, TextProvider | null> = {
    groq: env.GROQ_API_KEY ? { name: "groq", base: env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, model: env.GROQ_MODEL ?? "llama-3.3-70b-versatile" } : null,
    gemini: env.GEMINI_API_KEY ? { name: "gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", key: env.GEMINI_API_KEY, model: env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash" } : null,
    huggingface: env.HF_TOKEN && env.HF_MODEL ? { name: "huggingface", base: env.HF_BASE_URL ?? "https://router.huggingface.co/v1", key: env.HF_TOKEN, model: env.HF_MODEL } : null,
    custom: env.LLM_BASE_URL && env.LLM_MODEL ? { name: "custom", base: env.LLM_BASE_URL, key: env.LLM_API_KEY, model: env.LLM_MODEL } : null,
  };
  const order = (env.TEXT_MODELS ?? "groq,gemini,huggingface,custom").split(",").map((x) => x.trim().replace(/^hf$/, "huggingface"));
  return order.map((n) => all[n]).filter((x): x is TextProvider => Boolean(x));
}

export const llmConfigured = () => textProviders().length > 0;

export function buildLlmPrompt(title: string, sentences: Segment[], cfg: Config, n: number): string {
  const lines = sentences.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
  return `You are an expert short-form video editor for YouTube Shorts and TikTok.
Below is a timestamped transcript of a long video titled "${title}". Each line is "[start-end] text" in seconds.

Pick up to ${n} clips. Every clip MUST:
1. Be between ${cfg.clip.minS} and ${cfg.clip.maxS} seconds long (end minus start).
2. Start at the beginning of a line and end at the end of a line, using timestamps that appear verbatim in the transcript.
3. Be fully self-contained and understandable without the rest of the video.
4. Open with a strong hook in the first 3 seconds.
5. Not overlap any other clip.

Reply with ONLY a JSON object, no other text:
{"clips":[{"start":12.3,"end":55.0,"headline":"max 7 words, no emoji","title":"max 90 characters, no hashtags","description":"1-2 sentences, max 280 characters","hashtags":["three","to","five"],"score":80}]}

TRANSCRIPT:
${lines}`;
}

/** Pull the JSON object out of a model reply, tolerating code fences and chatter around it. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model reply contained no JSON");
  return JSON.parse(body.slice(a, b + 1));
}

export function parseLlmClips(reply: string): RawHighlight[] {
  const j = extractJson(reply) as { clips?: Record<string, unknown>[] };
  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, "")));
  return (j.clips ?? []).map((c) => ({
    startS: num(c.start ?? c.startSeconds ?? c.start_s),
    endS: num(c.end ?? c.endSeconds ?? c.end_s),
    headline: String(c.headline ?? ""),
    title: String(c.title ?? ""),
    description: String(c.description ?? ""),
    hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
    score: Number(c.score ?? 50),
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(prompt: string, prov: TextProvider): Promise<string> {
  const base = prov.base.replace(/\/$/, "");
  const key = prov.key;
  let useFormat = true;
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: prov.model,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You output only valid JSON." },
          { role: "user", content: prompt },
        ],
        ...(useFormat ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (r.ok) {
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const text = j.choices?.[0]?.message?.content;
      if (text) return text;
      lastErr = "empty reply";
    } else {
      const body = (await r.text()).slice(0, 200);
      lastErr = `HTTP ${r.status} ${body}`;
      if (r.status === 400 && useFormat) { useFormat = false; continue; } // some servers do not support response_format
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    }
    await sleep(Math.min(30_000, 3000 * 2 ** attempt));
  }
  throw new Error(`${prov.name} text model failed: ${lastErr}`);
}

/** Ask the configured text models, one after another, to choose moments. The first that yields clips wins. */
export async function llmHighlights(sentences: Segment[], title: string, durationS: number, cfg: Config, nMax: number, providers: TextProvider[] = textProviders()): Promise<Highlight[]> {
  const WIN = 20 * 60;
  const groups: Segment[][] = [];
  for (const s of sentences) {
    const k = Math.floor(s.start / WIN);
    (groups[k] ??= []).push(s);
  }
  const wins = groups.filter(Boolean);
  const per = Math.max(2, Math.ceil(nMax / wins.length) + 1);
  const failures: string[] = [];
  for (const prov of providers) {
    try {
      const raw: RawHighlight[] = [];
      for (const w of wins) {
        const reply = await chat(buildLlmPrompt(title, w, cfg, per), prov);
        try {
          raw.push(...parseLlmClips(reply));
        } catch (e) {
          log.warn(`Could not read ${prov.name}'s reply (${(e as Error).message}); skipping that part`);
        }
      }
      const out = snapToSentences(raw, sentences, durationS, cfg.clip.minS, cfg.clip.maxS, nMax);
      if (out.length) {
        log.info(`Moments chosen by ${prov.name} (${prov.model})`);
        return out;
      }
      failures.push(`${prov.name}: no usable clips`);
    } catch (e) {
      failures.push(String((e as Error).message).slice(0, 160));
      log.warn(`${prov.name} failed; trying the next text model`);
    }
  }
  throw new Error(providers.length ? `no text model produced clips (${failures.join(" | ")})` : "no text model is configured");
}
