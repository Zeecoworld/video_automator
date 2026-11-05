import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cloud hosts have no file you can mount, so cookies arrive as a variable:
 *   YTDLP_COOKIES      the cookies.txt text
 *   YTDLP_COOKIES_B64  the same file base64-encoded (safer where dashboards mangle line breaks)
 * They are written to a private temp file and YTDLP_COOKIES_FILE is pointed at it.
 * On Render, a Secret File named cookies.txt (at /etc/secrets/cookies.txt) works too.
 */
export function prepareCookies(env: NodeJS.ProcessEnv = process.env, secretFile = "/etc/secrets/cookies.txt"): string | null {
  // Render "Secret Files" are mounted at /etc/secrets/<name>; use one called cookies.txt if present.
  if (!env.YTDLP_COOKIES && !env.YTDLP_COOKIES_B64 && fs.existsSync(secretFile)) {
    env.YTDLP_COOKIES_FILE = secretFile;
    return secretFile;
  }
  const raw = env.YTDLP_COOKIES_B64 ? Buffer.from(env.YTDLP_COOKIES_B64, "base64").toString("utf8") : env.YTDLP_COOKIES;
  if (!raw || !raw.includes("\t")) return null; // a Netscape cookie file always has tab-separated columns
  const file = path.join(os.tmpdir(), "yt-cookies.txt");
  fs.writeFileSync(file, raw.replace(/\r\n/g, "\n").replace(/\\n/g, "\n"), { mode: 0o600 });
  env.YTDLP_COOKIES_FILE = file;
  return file;
}
