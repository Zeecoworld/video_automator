# clip-engine: paste links, get posted clips

## Architecture

| Layer | Service | Role here |
|---|---|---|
| Dashboard + API | **Netlify** | The page, `/api/*` functions, scheduled posting every 30 min, YouTube sign-in, clip actions |
| Data | **Supabase** | `users` (email sign-in), `sources` (video URLs), `clips` (jobs, schedule, status), `kv` (tokens, locks) |
| Primary processing | **Modal** | Downloads (`yt-dlp`), transcribes, picks moments, cuts clips with `ffmpeg`, uploads them (`modal/app.py`) |
| Optional backup | **GitHub Actions** | `tests.yml` (tests), `maintenance.yml` (housekeeping every 6 h + fallback processing when Modal falls behind), `worker.yml` (manual run) |
| AI | **Groq, Gemini, Hugging Face** (+ local Faster-Whisper) | Transcription and highlight identification, tried in order with automatic fallback |
| Clip storage | **Cloudflare R2 / Cloudinary** (+ Supabase Storage as last resort) | Holds a clip until it is posted, then it is deleted |

**Flow:** you sign in and paste YouTube / Instagram links -> saved in Supabase -> the Modal worker downloads them -> **transcription** (first working of Groq Whisper, Hugging Face, local Faster-Whisper) -> **moments** chosen by the first working text model (Groq, Gemini, Hugging Face, or your own), else a rule-based picker -> `ffmpeg` cuts vertical clips with the headline and **burned-in subtitles** -> uploaded to R2 or Cloudinary -> Netlify posts to YouTube / TikTok on schedule -> **once the platform confirms, the stored file is deleted.**

```
Netlify page --/api/ingest--> Supabase (sources) --wakes--> Modal worker
   Modal: yt-dlp -> ffmpeg audio -> transcript (Groq | Hugging Face | Faster-Whisper) -> moments (Groq | Gemini | Hugging Face | rules)
          -> ffmpeg 9:16 + subtitles -> R2 / Cloudinary -> next free slot (Supabase clips)
Netlify scheduled function (every 30 min): due clip -> YouTube / TikTok -> delete the stored file
GitHub Actions every 6 h: housekeeping; if links have waited > 45 min and Modal holds no lock, process them there
```

## Set up each layer
1. **Supabase:** run `supabase/schema.sql` (safe to re-run; it adds the `users` table and `sources.created_by`). Copy the URL, the *service role* key (server only) and the *anon* key.
2. **Netlify:** connect the repo; add the variables from `.env.example`. Required: `SITE_URL`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MODAL_WORKER_URL`, the YouTube client (`YT_CLIENT_ID`/`YT_CLIENT_SECRET`) and one storage provider.
3. **Modal (primary worker):** `pip install modal fastapi`, `modal setup`, create the `clip-engine` secret (keys listed at the top of `modal/app.py`), `modal deploy modal/app.py`, and put the printed `start` URL in Netlify as `MODAL_WORKER_URL`.
4. **AI keys (set any; the more you set, the more fallbacks):** `GROQ_API_KEY`, `GEMINI_API_KEY`, `HF_TOKEN` (+ `HF_MODEL` for a Hugging Face text model). Put them in the Modal secret, and in GitHub secrets if you use the Actions fallback.
5. **Clip storage:** Cloudflare R2 (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) and/or `CLOUDINARY_URL`. R2 is tried first; Supabase Storage is the last resort. Put them in Netlify, Modal and (for the backup) GitHub.
6. **Email sign-in (optional):** set `SUPABASE_ANON_KEY` and `ALLOWED_EMAILS` (comma-separated) in Netlify. In Supabase -> Authentication -> URL Configuration, add your site URL as the Site URL and a Redirect URL. The dashboard then shows "Email me a sign-in link"; only listed emails can use it, and each person who signs in is recorded in `users`. Supabase's built-in email sender is rate-limited, so add your own SMTP in Supabase for regular use. The access key keeps working. Everyone allowed shares the same queue and channels; this is a shared workspace, not separate accounts.
7. **GitHub (backup):** add the same secrets (`SUPABASE_*`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `HF_TOKEN`, `HF_MODEL`, R2/Cloudinary, `YTDLP_COOKIES`) under Settings -> Secrets and variables -> Actions. `maintenance.yml` then runs by itself.
8. **YouTube / TikTok:** see "Setup" below. Open the dashboard and press **Connect YouTube**.

## How the AI layer picks and falls back
- **Transcription** (`TRANSCRIBERS=groq,huggingface,local`): Groq's hosted Whisper (word timestamps, so subtitles are exact) -> Hugging Face (best effort, segment timestamps) -> Faster-Whisper in the Modal image. Only configured ones are tried.
- **Moments** (`TEXT_MODELS=groq,gemini,huggingface,custom`): the first text model that returns usable clips wins; the clip edges snap to sentence boundaries. If all fail, a built-in rule-based picker is used.
- **No transcript at all** and `GEMINI_API_KEY` set: Gemini listens to the audio directly. `AI_PROVIDER=gemini` forces only that path.
- **Titles, descriptions and hashtags** come from the same step. Subtitles come from the transcript's word timestamps (`CAPTIONS=off` disables them).

## Other ways to run the worker
| Mode | Set | Notes |
|---|---|---|
| **Modal (primary)** | `MODAL_WORKER_URL` | As above. |
| GitHub Actions fallback | automatic | `maintenance.yml` starts a worker run only when links have waited too long and no worker holds the lock. |
| Render / any container host | nothing | `render.yaml` + `Dockerfile` run the same worker as an always-on service that polls the queue. |
| Your PC | nothing | `docker compose -f docker-compose.worker.yml up -d --build`, or `npm run worker:loop`. `npm run doctor` shows what is configured. |
| Netlify + Cobalt | `COBALT_API_URL` | No Python/yt-dlp: 720p, size caps, API transcription only. |

## The dashboard
Open your Netlify site and enter the access key. It refreshes itself every 10 seconds.
- **Summary tiles:** next post with a live countdown, scheduled clips, links in progress, recently posted, and clips that need attention.
- **Links:** each pasted link with plain-language progress (waiting for the worker, downloading, cutting clips 2 of 4, done) and a progress bar. Failed links show the reason and a **Retry** button.
- **Schedule:** every clip grouped by day (Today, Tomorrow...) with its time, a countdown, and when it will actually go live (posting checks run every 30 minutes). Tabs: Upcoming, Posted, Failed, All.
- **Per-clip buttons:** **Post now**, **Reschedule** (pick a date and time), **Preview** (Cloudinary clips), **Retry**, **Remove**. Posted YouTube clips link to the video. Clips that are posting or already posted can't be changed.
- Times are shown in your browser's time zone; slots are generated in the zone set by `POSTING_TIMEZONE` (default Africa/Lagos).

## Variations
Each highlight is rendered in the styles you tick on the page:
- **pad**: full frame over a blurred backdrop, accent headline box on top (best for 16:9 sources).
- **fill**: centre-crop to fill the vertical frame (best for vertical or centred subjects).
Ticking 2 styles doubles the clip count (and storage/render time). Each clip also gets its own AI headline, title, description and hashtags, and highlights vary in length (20-59 s).

## YouTube and TikTok setup
(The other layers are covered in "Set up each layer" above.)
1. **YouTube sign-in (from the dashboard):** in Google Cloud Console create a project and enable **YouTube Data API v3**. Set up the **OAuth consent screen** (publishing status **In production**; in *Testing* the login expires after 7 days, and you must list your own Google account as a test user). Then **Credentials -> Create credentials -> OAuth client ID -> Web application**, and add this under **Authorized redirect URIs**, exactly:
   `https://YOURSITE.netlify.app/api/auth/youtube/callback`
   Put the client ID and secret into Netlify as `YT_CLIENT_ID` and `YT_CLIENT_SECRET`, redeploy, open the dashboard and press **Connect YouTube**. Sign in with the Google account that owns the channel and pick the channel. The dashboard then shows the channel name, with **Switch channel** and **Disconnect** buttons. (Google shows an "unverified app" warning until the app is verified: click Advanced, then continue. The upload and read-only YouTube scopes are used. The old `npm run auth:youtube` script and a `YT_REFRESH_TOKEN` variable still work as a fallback.)
2. **TikTok**: developer app (Login Kit + Content Posting API), register a redirect URI, then `npm run auth:tiktok`.

Local checks: `npm install`, `npm run typecheck`, `npm test` (runs real ffmpeg), `npm run doctor` (shows which AI providers and storage are configured).

## Things that will bite you
- **YouTube and Instagram block cloud servers more often than home connections**, Modal's included. Export a logged-in `cookies.txt` into `YTDLP_COOKIES` (Modal secret / GitHub secret), and add `YTDLP_PROXY` (a residential proxy) if blocks continue. Instagram: public reels/posts work, private ones do not. Errors are shown on the page.
- **Rights:** downloading and reposting is for videos you own or are licensed to reuse. YouTube's terms restrict downloads, and both platforms act on reposted third-party content.
- **YouTube audit:** uploads from an unaudited API project are forced private until you pass Google's audit. Default quota allows about 6 uploads/day.
- **TikTok Direct Post** needs app approval; until then only private posts work (the engine detects what the account allows and warns). `TIKTOK_MODE=inbox` sends drafts instead.
- **Netlify usage:** background functions run up to 15 minutes each and chain themselves; check your plan's function limits.
- **Hugging Face transcription is best effort:** its API shape for timestamps varies by model/provider, so it sits after Groq in the chain. Its text models (`HF_MODEL`) use the standard chat format.
- **Subtitles need a transcript with timestamps** (Groq or Faster-Whisper give word timing; Hugging Face gives segment timing, so word times are estimated). With the Gemini-audio-only path there are no subtitles.
- **Model names change:** the default Groq text model is `llama-3.3-70b-versatile` and Whisper model `whisper-large-v3-turbo`; if Groq retires one, set `GROQ_MODEL` / `GROQ_WHISPER_MODEL`.
- **Free-tier limits:** Groq and Gemini free tiers are rate-limited; the chain moves to the next provider on errors.
- Videos shorter than 20 s (Shorts, Reels) become one clip of the whole video, with AI-written text; videos under 3 s are skipped (`clip.wholeVideoMinS`).
- Videos longer than 120 min are skipped (`maxSourceMinutes`). Output is 1080x1920. Queue depth is 7 days of posts per platform (`lookaheadDays`); the worker stops downloading once that is full.
- Failures retry 3 times. Platform rate limits pause that platform without burning retries. A crash between a successful post and the DB write could duplicate one post.

## Verified here
Typecheck and 104 tests. Real ffmpeg: audio extraction, pause detection, pad and fill renders, subtitles, cutting from an HTTP URL, 9-second videos. Mock servers standing in for the real services: Groq and Hugging Face transcription (request shape, parsing, errors), text-model fallback between providers, Cloudflare R2 (signed PUT/GET/DELETE), Supabase Auth checks, the Cobalt client, yt-dlp against a local file server. The dashboard (progress, schedule, actions, YouTube connect, email sign-in) runs in a simulated browser. `modal/app.py` loads with the Modal SDK, and the workflow files parse.
**Not verified:** live Groq, Hugging Face, Gemini, Cloudflare R2, Supabase Auth emails, Modal deploys, GitHub Actions runs, a Netlify deploy, real Faster-Whisper output (the model needs a download my test machine cannot do), YouTube and TikTok posting.
