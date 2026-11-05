import { spawnSync } from "node:child_process";
import { aiProvider } from "../src/env";
import { textProviders } from "../src/highlights-local";
import { storageOrder } from "../src/storage";
import { transcribers } from "../src/transcribe-api";
import { pythonBin } from "../src/transcribe";

/** `npm run doctor`: tells you what is missing before you wonder why a link failed. */
const bin = process.env.FFMPEG_PATH || "ffmpeg";
const checks: [string, boolean, string][] = [];
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

checks.push(["ffmpeg", run(bin, ["-version"]).status === 0, "install ffmpeg (or use the Docker image)"]);
checks.push(["yt-dlp", run(process.env.YTDLP_PATH || "yt-dlp", ["--version"]).status === 0, "install yt-dlp (or use the Docker image)"]);
const py = run(pythonBin(), ["-c", "import faster_whisper; print('ok')"]);
checks.push([`python + faster-whisper (${pythonBin()}) - optional when Groq/Hugging Face is set`, py.status === 0 || Boolean(process.env.GROQ_API_KEY || process.env.HF_TOKEN), "pip install faster-whisper (Python 3.9+), or set GROQ_API_KEY"]);
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) checks.push([k, Boolean(process.env[k]), "set it in .env.worker"]);
checks.push(["CLOUDINARY_URL (optional, Supabase Storage is the fallback)", true, ""]);

let bad = 0;
for (const [name, ok, hint] of checks) {
  console.log(`${ok ? "OK     " : "MISSING"} ${name}${ok ? "" : "  -> " + hint}`);
  if (!ok) bad++;
}
const provider = aiProvider();
const tr = transcribers().map((t) => t.name);
const tx = textProviders().map((t) => `${t.name} (${t.model})`);
console.log(`\nAI mode: ${provider}`);
console.log(`Transcription, in order: ${tr.length ? tr.join(" -> ") : "none (set GROQ_API_KEY / HF_TOKEN or install Faster-Whisper)"}`);
console.log(`Moment-picking models, in order: ${tx.length ? tx.join(" -> ") : "none (the built-in rule-based picker is used)"}${process.env.GEMINI_API_KEY ? "; Gemini also listens to the audio if no transcript can be made" : ""}`);
console.log(`Clip storage, in order: ${storageOrder().join(" -> ")}`);
if (provider === "gemini" && !process.env.GEMINI_API_KEY) { console.log("MISSING GEMINI_API_KEY"); bad++; }
process.exit(bad ? 1 : 0);
