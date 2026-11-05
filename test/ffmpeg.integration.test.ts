import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { extractAudio, ffmpegBin, probe } from "../src/ffmpeg";
import { analyzeSource } from "../src/pipeline";
import { renderClip } from "../src/render";

let dir: string;
let src: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "itest-"));
  src = path.join(dir, "src.mp4");
  // 24 s test video; the tone is muted from 8 s to 11 s to give us a real pause to detect
  execFileSync(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=24",
    "-af", "volume=enable='between(t,8,11)':volume=0",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src,
  ]);
}, 60_000);

describe("bundled ffmpeg", () => {
  it("probes, extracts audio and detects the pause", async () => {
    const info = await probe(src);
    expect(info).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    expect(info.durationS).toBeGreaterThan(23);
    const audio = path.join(dir, "a.mp3");
    const sil = await extractAudio(src, audio, info.durationS);
    expect(fs.statSync(audio).size).toBeGreaterThan(1000);
    expect(sil.some((s) => Math.abs(s.start - 8) < 0.6 && Math.abs(s.end - 11) < 0.6)).toBe(true);
  }, 60_000);

  it.each(["pad", "fill"] as const)("renders a vertical %s clip with the headline box", async (variant) => {
    const out = path.join(dir, `clip-${variant}.mp4`);
    const cfg = { ...defaultConfig, render: { ...defaultConfig.render, width: 720, height: 1280 } };
    await renderClip({
      srcUrl: src, hasAudio: true, out, workdir: path.join(dir, `w-${variant}`), cfg, variant,
      h: { startS: 12, endS: 16, headline: "Smoke test headline", title: "t", description: "d", hashtags: [], score: 1 },
    });
    const info = await probe(out);
    expect([info.width, info.height]).toEqual([720, 1280]);
    expect(info.hasAudio).toBe(true);
    expect(info.durationS).toBeGreaterThan(3.5);
    expect(info.durationS).toBeLessThan(4.6);
  }, 120_000);

  it("can cut from an HTTP URL using range requests", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      const size = fs.statSync(src).size;
      const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(m ? 206 : 200, {
        "Accept-Ranges": "bytes", "Content-Type": "video/mp4", "Content-Length": end - start + 1,
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      fs.createReadStream(src, { start, end }).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const url = `http://127.0.0.1:${port}/src.mp4`;
      expect((await probe(url)).durationS).toBeGreaterThan(23);
      const out = path.join(dir, "http.mp4");
      await renderClip({
        srcUrl: url, hasAudio: true, out, workdir: path.join(dir, "w2"), cfg: defaultConfig,
        h: { startS: 5, endS: 8, headline: "Remote cut", title: "t", description: "d", hashtags: [], score: 1 },
      });
      expect((await probe(out)).durationS).toBeGreaterThan(2.5);
    } finally {
      server.close();
    }
  }, 120_000);

  it("turns a 9-second video into one whole-video clip instead of failing", async () => {
    const tiny = path.join(dir, "tiny.mp4");
    execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=9",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=9", "-c:v", "libx264", "-c:a", "aac", "-shortest", tiny]);
    delete process.env.GEMINI_API_KEY; // no AI key: text falls back to the title
    const src = { id: "s", platform: "youtube", url: "https://youtube.com/shorts/x", title: null, variants: ["pad"] } as never;
    const plan = await analyzeSource(src, tiny, defaultConfig, 4, "Tiny Short");
    expect(plan.highlights).toHaveLength(1);
    expect(plan.highlights[0].startS).toBe(0);
    expect(plan.highlights[0].endS).toBeGreaterThan(8.5);
    expect(plan.highlights[0].title).toBe("Tiny Short");
    const out = path.join(dir, "tiny-clip.mp4");
    await renderClip({ srcUrl: tiny, hasAudio: true, out, workdir: path.join(dir, "wt"), cfg: { ...defaultConfig, render: { ...defaultConfig.render, width: 720, height: 1280 } }, h: plan.highlights[0] });
    expect((await probe(out)).durationS).toBeGreaterThan(8.5);
  }, 120_000);
});
