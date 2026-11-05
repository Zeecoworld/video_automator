"""
Modal worker: download (yt-dlp) -> AI picks highlights (Gemini) -> clip (ffmpeg) -> upload (Cloudinary).
Posting to YouTube/TikTok and deleting the Cloudinary file afterwards is done by the Netlify scheduled function.

It simply runs this repo's TypeScript worker (`npm run worker`) inside a container that has yt-dlp, ffmpeg and Node,
so the queue, scheduling and storage logic is shared with everything else.

Deploy:
  pip install modal fastapi && modal setup
  modal secret create clip-engine SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CRON_SECRET=... \
      GROQ_API_KEY=... GEMINI_API_KEY=... HF_TOKEN=... HF_MODEL=... \
      R2_ACCOUNT_ID=... R2_BUCKET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
      CLOUDINARY_URL=... YTDLP_COOKIES="$(cat cookies.txt)"
  (set only what you use; Faster-Whisper is installed in the image as the last transcription fallback)
  modal deploy modal/app.py        # prints the URL of the `start` endpoint -> set it as MODAL_WORKER_URL on Netlify
"""
import os
import subprocess
from pathlib import Path

import modal
from fastapi import HTTPException, Request  # local `pip install fastapi` is needed for the endpoint's type hints

REPO = Path(os.environ.get("CLIP_REPO") or Path(__file__).resolve().parent.parent)
# Only check on your own machine. Inside the Modal container this file lives elsewhere and the project folder
# does not exist, so checking there would stop the container from starting.
if modal.is_local() and not (REPO / "package.json").exists():
    raise SystemExit(
        f"package.json not found in {REPO}.\n"
        "Keep modal/app.py inside the project folder and run `modal deploy modal/app.py` from the project root "
        "(or set CLIP_REPO to the project folder path)."
    )

app = modal.App("clip-engine")

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .apt_install("ffmpeg", "curl", "ca-certificates", "unzip", "fonts-dejavu-core")
    .run_commands(
        "curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp",
        "chmod a+rx /usr/local/bin/yt-dlp",
        # yt-dlp needs a JS runtime to solve YouTube's player challenges
        "curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh",
    )
    .pip_install("fastapi[standard]", "faster-whisper")
    .add_local_dir(
        str(REPO),
        remote_path="/app",
        copy=True,
        ignore=["node_modules/**", ".git/**", ".netlify/**", "modal/**", "test/**", "*.zip"],
    )
    .run_commands("cd /app && npm install --no-audit --no-fund")
)

secrets = [modal.Secret.from_name("clip-engine")]


@app.function(
    image=image,
    secrets=secrets,
    cpu=4,
    memory=8192,
    timeout=6 * 3600,
    schedule=modal.Cron("0 */3 * * *"),  # safety net; pasting links also starts it immediately via `start`
)
def run_worker() -> int:
    env = {**os.environ, "FFMPEG_PATH": "/usr/bin/ffmpeg", "DOWNLOADER": "ytdlp", "PYTHON_BIN": "python", "PATH": f"/usr/local/bin:{os.environ['PATH']}"}
    cookies = os.environ.get("YTDLP_COOKIES")
    if cookies:
        Path("/tmp/cookies.txt").write_text(cookies)
        env["YTDLP_COOKIES_FILE"] = "/tmp/cookies.txt"
    # A DB lock inside the worker stops two runs from working the queue at once.
    return subprocess.run(["npm", "run", "worker"], cwd="/app", env=env).returncode


@app.function(image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]"), secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def start(request: Request):
    if request.headers.get("x-cron-secret") != os.environ.get("CRON_SECRET"):
        raise HTTPException(status_code=401, detail="unauthorized")
    run_worker.spawn()
    return {"started": True}
