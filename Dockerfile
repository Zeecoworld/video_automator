# Worker for your own computer or a VPS: yt-dlp + ffmpeg + Faster-Whisper + the TypeScript worker. No Modal, no Gemini.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv curl ca-certificates unzip fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp
# yt-dlp needs a JS runtime to solve YouTube's player challenges
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ENV PYTHON_BIN=/opt/venv/bin/python \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    DOWNLOADER=ytdlp \
    AI_PROVIDER=local \
    WORKER_MODE=local \
    YTDLP_COOKIES_FILE=/secrets/cookies.txt

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
CMD ["npx", "tsx", "worker/loop.ts"]
