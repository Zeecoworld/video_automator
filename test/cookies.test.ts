import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareCookies } from "../src/cookies";

const COOKIES = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc123\n";

describe("cookies from the environment", () => {
  it("writes plain text cookies to a private file and points yt-dlp at it", () => {
    const env: NodeJS.ProcessEnv = { YTDLP_COOKIES: COOKIES };
    const file = prepareCookies(env)!;
    expect(env.YTDLP_COOKIES_FILE).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(COOKIES);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
  it("accepts base64 and flattened line breaks", () => {
    const b64: NodeJS.ProcessEnv = { YTDLP_COOKIES_B64: Buffer.from(COOKIES).toString("base64") };
    expect(fs.readFileSync(prepareCookies(b64)!, "utf8")).toBe(COOKIES);
    const flat: NodeJS.ProcessEnv = { YTDLP_COOKIES: COOKIES.replace(/\n/g, "\\n") };
    expect(fs.readFileSync(prepareCookies(flat)!, "utf8")).toBe(COOKIES);
  });
  it("uses a Render secret file when no variable is set", () => {
    const f = require("node:path").join(require("node:os").tmpdir(), "fake-secret-cookies.txt");
    fs.writeFileSync(f, COOKIES);
    const env: NodeJS.ProcessEnv = {};
    expect(prepareCookies(env, f)).toBe(f);
    expect(env.YTDLP_COOKIES_FILE).toBe(f);
    expect(prepareCookies({}, "/definitely/missing.txt")).toBeNull();
  });
  it("ignores empty or invalid values", () => {
    expect(prepareCookies({}, "/definitely/missing.txt")).toBeNull();
    expect(prepareCookies({ YTDLP_COOKIES: "not a cookie file" }, "/definitely/missing.txt")).toBeNull();
  });
});
