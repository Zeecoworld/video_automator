import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { fallbackHighlights, snapPlan, titleFromUrl, wholeVideoHighlight, type RawHighlight } from "../src/highlights";
import type { Silence } from "../src/types";

const hl = (startS: number, endS: number, score = 50, headline = "Big hook!"): RawHighlight => ({
  startS, endS, headline, title: "T", description: "D", hashtags: ["#ai", "ai", "Tech"], score,
});
// pauses every ~10s
const silences: Silence[] = Array.from({ length: 19 }, (_, i) => ({ start: (i + 1) * 10 - 0.4, end: (i + 1) * 10 + 0.2 }));

describe("snapPlan", () => {
  it("snaps to the nearest pauses and pads slightly", () => {
    const [c] = snapPlan([hl(11.4, 49.2)], silences, 200, 20, 59, 5);
    expect(c.startS).toBeCloseTo(10.2 - 0.1, 5);
    expect(c.endS).toBeCloseTo(49.6 + 0.25, 5);
    expect(c.hashtags).toEqual(["ai", "Tech"]);
  });

  it("shrinks over-long and extends too-short clips into range", () => {
    const [long] = snapPlan([hl(0, 190)], silences, 200, 20, 59, 5);
    expect(long.endS - long.startS).toBeLessThanOrEqual(59.5);
    const [short] = snapPlan([hl(10, 15)], silences, 200, 20, 59, 5);
    expect(short.endS - short.startS).toBeGreaterThanOrEqual(20);
  });

  it("drops overlaps (keeps the higher score) and honours the limit", () => {
    const out = snapPlan([hl(0, 40, 10), hl(20, 60, 90), hl(100, 140, 50)], silences, 200, 20, 59, 5);
    expect(out.map((c) => Math.round(c.startS / 10) * 10)).toEqual([20, 100]);
    expect(snapPlan([hl(0, 30), hl(50, 80), hl(100, 130)], silences, 200, 20, 59, 2)).toHaveLength(2);
  });

  it("discards invalid timestamps and cleans the headline", () => {
    expect(snapPlan([hl(NaN, 50), hl(50, 40)], silences, 200, 20, 59, 5)).toHaveLength(0);
    const [c] = snapPlan([hl(0, 40, 50, "🔥 One two three four five six seven eight nine ten")], silences, 200, 20, 59, 5);
    expect(c.headline.split(" ")[0]).toBe("One");
    expect(c.headline.split(" ").length).toBeLessThanOrEqual(8);
  });
});

describe("fallbackHighlights", () => {
  it("makes sequential in-range clips with no speech", () => {
    const out = fallbackHighlights([], 200, "My Video", defaultConfig, 8);
    expect(out.length).toBeGreaterThanOrEqual(3);
    out.slice(1).forEach((c, i) => expect(c.startS).toBe(out[i].endS));
    out.forEach((c) => {
      expect(c.endS - c.startS).toBeGreaterThanOrEqual(defaultConfig.clip.minS);
      expect(c.endS - c.startS).toBeLessThanOrEqual(defaultConfig.clip.maxS);
    });
    expect(out[0].title.endsWith(`(Part 1/${out.length})`)).toBe(true);
  });
});

describe("titleFromUrl", () => {
  it("derives a readable title", () => {
    expect(titleFromUrl("https://cdn.example.com/v/how-ai_agents%20work.mp4?x=1")).toBe("how ai agents work");
  });
});

describe("wholeVideoHighlight", () => {
  it("keeps the whole video and prefers AI text", () => {
    const h = wholeVideoHighlight(9.4, "My Short", { headline: "Wait for it", title: "A better title", description: "Desc", hashtags: ["fun"], score: 70 });
    expect([h.startS, h.endS]).toEqual([0, 9.4]);
    expect(h).toMatchObject({ headline: "Wait for it", title: "A better title", hashtags: ["fun"] });
  });
  it("falls back to the video title", () => {
    const h = wholeVideoHighlight(9, "Learn Python in nine seconds flat today please");
    expect(h.title).toBe("Learn Python in nine seconds flat today please");
    expect(h.headline.split(" ").length).toBeLessThanOrEqual(7);
    expect(h.hashtags).toEqual(["shorts"]);
  });
});
