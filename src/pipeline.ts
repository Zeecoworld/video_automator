import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config";
import * as db from "./db";
import { aiProvider, opt } from "./env";
import { SourceSkip } from "./errors";
import { extractAudio, probe } from "./ffmpeg";
import { planClips } from "./gemini";
import { fallbackHighlights, snapPlan, titleFromUrl, wholeVideoHighlight } from "./highlights";
import { heuristicHighlights, llmConfigured, llmHighlights, metaFromSentences } from "./highlights-local";
import { toSentences, wordCount, wordsBetween, type Segment } from "./transcribe";
import { transcribeAny } from "./transcribe-api";
import { renderClip } from "./render";
import { log } from "./runtime";
import { assignSlots } from "./scheduler";
import * as storage from "./storage";
import type { Cap, Highlight, Plan, Silence, SourceRow, Variant } from "./types";

export const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
export const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

export interface Job {
  h: Highlight;
  variant: Variant;
}

/** Every planned highlight x every requested variation. The job index is what `sources.rendered` counts. */
export function jobsOf(plan: Plan, variants: Variant[]): Job[] {
  const vs: Variant[] = variants.length ? variants : ["pad"];
  return plan.highlights.flatMap((h) => vs.map((variant) => ({ h, variant })));
}

/** Probe the local file, let Gemini listen to the audio and choose highlights, snap them to pauses. */
export async function analyzeSource(src: SourceRow, input: string, cfg: Config, nMax: number, title?: string): Promise<Plan> {
  const info = await probe(input);
  if (info.durationS > cfg.maxSourceMinutes * 60) {
    throw new SourceSkip(`video is ${(info.durationS / 60).toFixed(0)} min, limit is ${cfg.maxSourceMinutes}`);
  }
  if (info.durationS < cfg.clip.wholeVideoMinS) {
    throw new SourceSkip(`video is only ${info.durationS.toFixed(0)}s; the minimum is ${cfg.clip.wholeVideoMinS}s`);
  }
  const label = title || src.title || titleFromUrl(src.url);

  // Shorter than a normal clip: keep the whole video as one clip, with AI-written text when the audio allows it.
  if (info.durationS < cfg.clip.minS) {
    let meta: Partial<Highlight> | undefined;
    let words: Cap[] | undefined;
    if (info.hasAudio && aiProvider() !== "none") {
      const dir = tmp("audio-");
      try {
        const audio = path.join(dir, "audio.mp3");
        await extractAudio(input, audio, info.durationS);
        const geminiShort = async () => {
          const short = { ...cfg, clip: { ...cfg.clip, minS: 1, maxS: Math.ceil(info.durationS) } };
          meta = (await planClips(audio, label, info.durationS, 1, short))[0];
        };
        if (aiProvider() === "gemini") await geminiShort();
        else {
          try {
            const sents = toSentences((await transcribeAny(audio, cfg)).segments);
            if (sents.length) { meta = metaFromSentences(sents); words = wordsBetween(sents, 0, info.durationS); }
          } catch (e) {
            if (!opt("GEMINI_API_KEY")) throw e;
            await geminiShort(); // no transcript: let Gemini listen instead
          }
        }
      } catch (e) {
        log.warn(`Could not generate text for a short video (${errMsg(e).slice(0, 150)}); using its title`);
      } finally {
        rm(dir);
      }
    }
    const h = wholeVideoHighlight(info.durationS, label, meta);
    if (words?.length) h.words = words;
    return { title: label, durationS: info.durationS, hasAudio: info.hasAudio, highlights: [h] };
  }

  let silences: Silence[] = [];
  let highlights: Highlight[] = [];
  const provider = aiProvider();
  if (info.hasAudio && provider !== "none") {
    const dir = tmp("audio-");
    try {
      const audio = path.join(dir, "audio.mp3");
      silences = await extractAudio(input, audio, info.durationS);
      try {
        const geminiAudio = async () => {
          const raw = await planClips(audio, label, info.durationS, nMax, cfg);
          highlights = snapPlan(raw, silences, info.durationS, cfg.clip.minS, cfg.clip.maxS, nMax);
        };
        if (provider === "gemini") await geminiAudio();
        else {
          let sents: Segment[] = [];
          try {
            sents = toSentences((await transcribeAny(audio, cfg)).segments);
          } catch (e) {
            log.warn(`No transcript (${errMsg(e).slice(0, 200)})`);
          }
          if (wordCount(sents) >= 40) {
            if (llmConfigured()) {
              try {
                highlights = await llmHighlights(sents, label, info.durationS, cfg, nMax);
              } catch (e) {
                log.warn(`Text models failed (${errMsg(e).slice(0, 200)}); using the rule-based picker`);
              }
            }
            if (!highlights.length) highlights = heuristicHighlights(sents, info.durationS, cfg, nMax);
            for (const h of highlights) h.words = wordsBetween(sents, h.startS, h.endS);
          } else if (opt("GEMINI_API_KEY")) {
            await geminiAudio(); // no usable transcript: Gemini listens to the audio instead
          }
        }
      } catch (e) {
        log.warn(`Highlight selection failed (${errMsg(e).slice(0, 200)}); using fallback`);
      }
    } catch (e) {
      log.warn(`Audio analysis failed (${errMsg(e).slice(0, 200)}); using fallback`);
    } finally {
      rm(dir);
    }
  }
  if (!highlights.length) highlights = fallbackHighlights(silences, info.durationS, label, cfg, nMax);
  if (!highlights.length) throw new SourceSkip("no usable clips found");
  return { title: label, durationS: info.durationS, hasAudio: info.hasAudio, highlights };
}

/** Render the remaining jobs of a planned source, upload each clip and queue it in the next free slot. Resumable. */
export async function renderJobs(
  src: SourceRow, input: string, cfg: Config, deadline: number, perDay: number,
): Promise<{ created: number; finished: boolean }> {
  const plan = src.plan!;
  const jobs = jobsOf(plan, src.variants);
  let done = src.rendered;
  let created = 0;
  while (done < jobs.length) {
    if (deadline - Date.now() < cfg.renderBudgetMs) return { created, finished: false };
    const { h, variant } = jobs[done];
    const dir = tmp("clip-");
    const id = randomUUID();
    let stored: storage.Stored | undefined;
    try {
      const out = path.join(dir, "clip.mp4");
      log.info(`Rendering ${done + 1}/${jobs.length} [${variant}] ${h.startS.toFixed(1)}-${h.endS.toFixed(1)}s ${h.title}`);
      await renderClip({ srcUrl: input, h, hasAudio: plan.hasAudio, out, workdir: dir, cfg, variant });
      stored = await storage.uploadClip(fs.readFileSync(out), `clip-engine/${src.platform}/${id}`);
      const [slot] = assignSlots(await db.futureSlots(src.platform), 1, db.now(), perDay, cfg.windowStart, cfg.windowEnd, cfg.timezone);
      await db.insertClip({
        id, source_id: src.id, platform: src.platform, idx: done, variant, start_s: h.startS, end_s: h.endS,
        headline: h.headline, title: h.title, description: h.description, hashtags: h.hashtags,
        storage_provider: stored.provider, storage_key: stored.key, storage_url: stored.url,
        status: "ready", scheduled_at: slot.toISOString(),
      });
    } catch (e) {
      if (stored) await storage.deleteClip(stored.provider, stored.key).catch(() => undefined);
      throw e;
    } finally {
      rm(dir);
    }
    done += 1;
    created += 1;
    await db.updateSource(src.id, { rendered: done });
  }
  await db.updateSource(src.id, { status: "done", error: null });
  return { created, finished: true };
}
