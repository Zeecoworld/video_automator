import type { Config } from "./config";
import type { Highlight, Silence } from "./types";

export type RawHighlight = Highlight;

const SNAP_TOLERANCE_S = 3;

/** Speech onset: the end of the nearest silence. */
export function snapStart(t: number, silences: Silence[], tol = SNAP_TOLERANCE_S): number {
  let best = t;
  let bd = Infinity;
  for (const s of silences) {
    const d = Math.abs(s.end - t);
    if (d <= tol && d < bd) { bd = d; best = s.end; }
  }
  return best;
}

/** Speech offset: the start of the nearest silence. */
export function snapEnd(t: number, silences: Silence[], tol = SNAP_TOLERANCE_S): number {
  let best = t;
  let bd = Infinity;
  for (const s of silences) {
    const d = Math.abs(s.start - t);
    if (d <= tol && d < bd) { bd = d; best = s.start; }
  }
  return best;
}

export function cleanHighlight(h: Highlight): Highlight {
  const headline =
    h.headline.replace(/[^\p{L}\p{N}\s.,!?'’:;%$&@/+-]/gu, "").trim().split(/\s+/).slice(0, 8).join(" ") || "Watch this";
  const tags: string[] = [];
  for (const t of h.hashtags ?? []) {
    const c = String(t).replace(/[^\p{L}\p{N}_]/gu, "");
    if (c && !tags.some((x) => x.toLowerCase() === c.toLowerCase())) tags.push(c);
  }
  return {
    ...h,
    headline,
    title: (h.title ?? "").trim().slice(0, 95) || headline,
    description: (h.description ?? "").trim().slice(0, 300),
    hashtags: tags.slice(0, 5),
    score: Number.isFinite(h.score) ? h.score : 50,
  };
}

/** Snap model timestamps to real pauses in the audio, enforce length limits, drop overlaps. */
export function snapPlan(
  raw: RawHighlight[], silences: Silence[], durationS: number, minS: number, maxS: number, limit: number,
): Highlight[] {
  const cands: Highlight[] = [];
  for (const h of raw) {
    if (!Number.isFinite(h.startS) || !Number.isFinite(h.endS) || h.endS <= h.startS) continue;
    const start = Math.max(0, snapStart(h.startS, silences));
    let end = Math.min(durationS, snapEnd(h.endS, silences));
    if (end - start > maxS) {
      const cut = silences.filter((s) => s.start > start + minS && s.start <= start + maxS).map((s) => s.start).pop();
      end = cut ?? start + maxS;
    }
    if (end - start < minS) {
      const ext = silences.find((s) => s.start >= start + minS && s.start <= start + maxS);
      if (ext) end = Math.min(durationS, ext.start);
    }
    if (end - start < minS || end - start > maxS) continue;
    cands.push(cleanHighlight({ ...h, startS: Math.max(0, start - 0.1), endS: Math.min(durationS, end + 0.25) }));
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen: Highlight[] = [];
  for (const h of cands) {
    if (chosen.every((c) => h.endS <= c.startS || h.startS >= c.endS)) chosen.push(h);
    if (chosen.length >= limit) break;
  }
  return chosen.sort((a, b) => a.startS - b.startS);
}

/** No speech, or Gemini unavailable: sequential windows snapped to pauses, so the queue never stalls. */
export function fallbackHighlights(silences: Silence[], durationS: number, title: string, cfg: Config, nMax: number): Highlight[] {
  const { minS, maxS } = cfg.clip;
  const target = Math.min(45, maxS - 4);
  const bounds: [number, number][] = [];
  let t = 0;
  while (t + minS <= durationS && bounds.length < nMax) {
    let end = Math.min(t + target, durationS);
    const near = silences.map((s) => s.start).filter((s) => Math.abs(s - end) <= 6 && s - t >= minS && s - t <= maxS);
    if (near.length) end = near.reduce((a, b) => (Math.abs(b - end) < Math.abs(a - end) ? b : a));
    if (durationS - end < minS && durationS - t <= maxS) end = durationS;
    bounds.push([t, end]);
    t = end;
  }
  const n = bounds.length;
  const base = title.replace(/[^\p{L}\p{N}\s.,!?'’:;%$&@/+-]/gu, "").trim() || "Clip";
  return bounds.map(([a, b], i) => ({
    startS: a,
    endS: b,
    headline: n > 1 ? `Part ${i + 1}` : base.slice(0, 40),
    title: n > 1 ? `${base.slice(0, 78)} (Part ${i + 1}/${n})` : base.slice(0, 90),
    description: base.slice(0, 200),
    hashtags: ["shorts", "viral"],
    score: 50,
  }));
}

/** A video shorter than the normal minimum clip length (a YouTube Short, a Reel) becomes one clip: the whole video. */
export function wholeVideoHighlight(durationS: number, title: string, meta?: Partial<Highlight>): Highlight {
  const base = title.replace(/[^\p{L}\p{N}\s.,!?'’:;%$&@/+-]/gu, "").trim() || "Clip";
  return cleanHighlight({
    startS: 0,
    endS: durationS,
    headline: meta?.headline?.trim() || base.split(/\s+/).slice(0, 7).join(" "),
    title: meta?.title?.trim() || base.slice(0, 90),
    description: meta?.description?.trim() || base.slice(0, 200),
    hashtags: meta?.hashtags?.length ? meta.hashtags : ["shorts"],
    score: meta?.score ?? 50,
  });
}

export function titleFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    const t = last.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[-_]+/g, " ").trim();
    return t || "Clip";
  } catch {
    return "Clip";
  }
}
