import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadViaCobalt, friendlyCobaltError, interpret } from "../src/cobalt";
import { defaultConfig } from "../src/config";
import { downloaderName } from "../src/download";
import { SourceSkip } from "../src/errors";
import { ffmpegBin } from "../src/ffmpeg";

describe("cobalt response handling", () => {
  it("accepts tunnel and redirect", () => {
    expect(interpret({ status: "tunnel", url: "https://x/t", filename: "a.mp4" })).toEqual({ url: "https://x/t", filename: "a.mp4" });
    expect(interpret({ status: "redirect", url: "https://x/r" }).url).toBe("https://x/r");
  });
  it("picks the first video from a picker, and skips photo-only posts", () => {
    expect(interpret({ status: "picker", picker: [{ type: "photo", url: "p" }, { type: "video", url: "v" }] }).url).toBe("v");
    expect(() => interpret({ status: "picker", picker: [{ type: "photo", url: "p" }] })).toThrow(SourceSkip);
  });
  it("turns errors into actionable messages", () => {
    expect(() => interpret({ status: "error", error: { code: "error.api.auth.key.missing" } })).toThrow(/COBALT_API_KEY/);
    expect(() => interpret({ status: "local-processing" })).toThrow(/FORCE_LOCAL_PROCESSING/);
    expect(() => interpret({ nope: 1 })).toThrow(/unexpected/);
    expect(friendlyCobaltError("error.api.content.video.private")).toMatch(/private/);
    expect(friendlyCobaltError("error.api.youtube.login")).toMatch(/sign in/);
  });
  it("chooses the downloader from the environment", () => {
    const before = { ...process.env };
    delete process.env.DOWNLOADER; delete process.env.COBALT_API_URL;
    expect(downloaderName()).toBe("ytdlp");
    process.env.COBALT_API_URL = "https://c.example";
    expect(downloaderName()).toBe("cobalt");
    process.env.DOWNLOADER = "ytdlp";
    expect(downloaderName()).toBe("ytdlp");
    process.env = before;
  });
});

describe("downloadViaCobalt against a mock Cobalt server", () => {
  let dir: string, video: string, server: http.Server, base: string;
  const seen: { auth?: string; body?: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cobalt-"));
    video = path.join(dir, "v.mp4");
    execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=10", "-c:v", "libx264", "-c:a", "aac", "-shortest", video]);
    server = http.createServer((req, res) => {
      if (req.method === "POST") {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
          const body = JSON.parse(b);
          seen.push({ auth: req.headers.authorization, body });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ status: "tunnel", url: `${base}/file`, filename: "youtube_abc_640x360.mp4" }));
        });
      } else {
        res.setHeader("content-type", "video/mp4"); // no content-length: like a streamed tunnel
        fs.createReadStream(video).pipe(res);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.COBALT_API_URL = base + "/";
    process.env.COBALT_API_KEY = "secret-key";
  });
  afterAll(() => { server.close(); delete process.env.COBALT_API_URL; delete process.env.COBALT_API_KEY; });

  it("resolves, streams the file to disk and sends the right request", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
    const d = await downloadViaCobalt("https://cdn.example.com/my-video.mp4", out, defaultConfig);
    expect(d.path.endsWith(".mp4")).toBe(true);
    expect(fs.statSync(d.path).size).toBe(fs.statSync(video).size);
    expect(seen[0].auth).toBe("Api-Key secret-key");
    expect(seen[0].body).toMatchObject({ url: "https://cdn.example.com/my-video.mp4", videoQuality: "720", downloadMode: "auto" });
  });

  it("aborts when a streamed download exceeds the size cap", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
    const tiny = { ...defaultConfig, download: { quality: "720", maxMb: 0.01 } };
    await expect(downloadViaCobalt("https://cdn.example.com/x.mp4", out, tiny)).rejects.toThrow(/limit is/);
    expect(fs.readdirSync(out)).toHaveLength(0);
  });
});
