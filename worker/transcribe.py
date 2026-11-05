"""Faster-Whisper transcription with word timestamps.

Usage: python transcribe.py AUDIO_FILE [MODEL]     (MODEL: tiny | base | small | medium | large-v3, default small)
Prints one JSON document on stdout: {"language": "en", "segments": [{"start", "end", "text", "words": [{"start", "end", "word"}]}]}
Progress goes to stderr. Runs on CPU by default; set WHISPER_DEVICE=cuda and WHISPER_COMPUTE=float16 for a GPU.
"""
import json
import os
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe.py AUDIO_FILE [MODEL]", file=sys.stderr)
        return 2
    audio = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "small"
    model = WhisperModel(
        name,
        device=os.environ.get("WHISPER_DEVICE", "cpu"),
        compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
    )
    segments, info = model.transcribe(
        audio,
        beam_size=1,
        vad_filter=True,
        word_timestamps=True,
        language=os.environ.get("WHISPER_LANGUAGE") or None,
    )
    out = []
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip()}
            for w in (s.words or [])
            if w.word.strip()
        ]
        out.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text, "words": words})
        print(f"  transcribed to {s.end:.0f}s", file=sys.stderr, flush=True)
    json.dump({"language": getattr(info, "language", None), "segments": out}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
