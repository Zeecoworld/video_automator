import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/links";
import { friendlyError, parseInfo } from "../src/ytdlp";
import { jobsOf } from "../src/pipeline";
import { parsePlan, toSeconds } from "../src/gemini";
import { assColor, assTime, buildFilter, buildHeadlineAss, wrapHeadline } from "../src/render";
import { defaultConfig } from "../src/config";
import { parseCloudinaryUrl, signParams } from "../src/storage";
import { parseProbe, parseSilences } from "../src/ffmpeg";

describe("links", () => {
  it("extracts, dedupes and labels links from messy pasted text", () => {
    const out = extractLinks(`
      check this https://www.youtube.com/watch?v=abc123, and (https://youtu.be/xyz789).
      https://www.instagram.com/reel/C8abc/?igsh=1  https://www.youtube.com/watch?v=abc123
      https://cdn.example.com/video.mp4 not-a-link
    `);
    expect(out.map((l) => l.kind)).toEqual(["youtube", "youtube", "instagram", "other"]);
    expect(out[1].url).toBe("https://youtu.be/xyz789");
    expect(out).toHaveLength(4);
  });
});

describe("yt-dlp helpers", () => {
  it("parses info and gives actionable errors", () => {
    expect(parseInfo(JSON.stringify({ title: " My talk ", duration: 612.4 }))).toEqual({ title: "My talk", durationS: 612.4 });
    expect(friendlyError("ERROR: Sign in to confirm you’re not a bot")).toMatch(/YTDLP_COOKIES/);
    expect(friendlyError("ERROR: [Instagram] X: Requested content is not available, rate-limit reached or login required")).toMatch(/Instagram/);
    expect(friendlyError("ERROR: Private video. Sign in if you've been granted access")).toMatch(/private/i);
  });
});

describe("variations", () => {
  it("expands every highlight into one job per variant", () => {
    const h = (n: number) => ({ startS: n, endS: n + 30, headline: "h", title: "t", description: "d", hashtags: [], score: 1 });
    const plan = { title: "x", durationS: 100, hasAudio: true, highlights: [h(0), h(40)] };
    expect(jobsOf(plan, ["pad"]).map((j) => j.variant)).toEqual(["pad", "pad"]);
    expect(jobsOf(plan, ["pad", "fill"]).map((j) => `${j.h.startS}:${j.variant}`)).toEqual(["0:pad", "0:fill", "40:pad", "40:fill"]);
    expect(jobsOf(plan, [])).toHaveLength(2);
  });
});

describe("gemini parsing", () => {
  it("accepts numbers, numeric strings and mm:ss", () => {
    expect(toSeconds(12.5)).toBe(12.5);
    expect(toSeconds("754.5")).toBe(754.5);
    expect(toSeconds("12:34")).toBe(754);
    expect(toSeconds("1:02:03")).toBe(3723);
    expect(toSeconds("nope")).toBeNaN();
  });
  it("parses the clip list", () => {
    const [c] = parsePlan(JSON.stringify({ clips: [{ startSeconds: "01:00", endSeconds: 95, headline: "h", title: "t", description: "d", hashtags: ["a"], score: 80 }] }));
    expect(c).toMatchObject({ startS: 60, endS: 95, score: 80, hashtags: ["a"] });
  });
});

describe("render helpers", () => {
  it("converts colours and times for ASS", () => {
    expect(assColor("#00ea90")).toBe("&H0090EA00");
    expect(assTime(61.5)).toBe("0:01:01.50");
    expect(assTime(3725)).toBe("1:02:05.00");
  });
  it("wraps and sanitises the headline", () => {
    const w = wrapHeadline("Stop wasting time on bad prompts 🔥");
    expect(w).toBe("STOP WASTING TIME\\NON BAD PROMPTS");
  });
  it("builds ASS and filter graph", () => {
    const ass = buildHeadlineAss("Hello there", 1080, 1920, defaultConfig, 45);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:45.00,Headline,,0,0,0,,HELLO THERE");
    const pad = buildFilter(720, 1280, "pad");
    expect(pad).toContain("boxblur");
    expect(pad).toContain("scale=90:160");
    const fill = buildFilter(720, 1280, "fill");
    expect(fill).not.toContain("boxblur");
    expect(fill).toContain("crop=720:1280");
    expect(fill).toContain("subtitles=headline.ass");
  });
});

describe("storage helpers", () => {
  it("parses CLOUDINARY_URL and signs sorted params", () => {
    expect(parseCloudinaryUrl("cloudinary://123:sec_ret@mycloud")).toEqual({ key: "123", secret: "sec_ret", cloud: "mycloud" });
    const a = signParams({ timestamp: 1, public_id: "x", overwrite: "true" }, "s");
    const b = signParams({ overwrite: "true", public_id: "x", timestamp: 1 }, "s");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("ffmpeg output parsing", () => {
  const err = `Input #0, mov,mp4, from 'x.mp4':
  Duration: 00:12:34.56, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 1100 kb/s, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s`;
  it("reads duration, size and audio", () => {
    expect(parseProbe(err)).toEqual({ durationS: 754.56, width: 1920, height: 1080, hasAudio: true });
    expect(parseProbe(err.replace(/.*Audio.*\n?/, "")).hasAudio).toBe(false);
  });
  it("pairs silence start/end and closes a trailing silence", () => {
    const s = parseSilences("[silencedetect @ 0x1] silence_start: 5.2\n[silencedetect @ 0x1] silence_end: 8.1 | silence_duration: 2.9\n[silencedetect @ 0x1] silence_start: 20.0", 25);
    expect(s).toEqual([{ start: 5.2, end: 8.1 }, { start: 20, end: 25 }]);
  });
});
