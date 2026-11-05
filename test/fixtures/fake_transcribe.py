"""Stand-in for worker/transcribe.py: prints a deterministic transcript (14 sentences, 5 s each) so tests need no model download."""
import json
import sys

LINES = [
    "Why do most people fail at learning Python?",
    "They jump between tutorials and never build anything real.",
    "Here is the one habit that fixes this problem completely.",
    "Pick a tiny project and finish it this week.",
    "A calculator counts, a quiz game counts, even a budget tracker counts.",
    "Finishing teaches you more than watching twenty hours of videos.",
    "And that is how real skills actually get built.",
    "Now let us talk about the second mistake people make.",
    "They never read other people's code.",
    "Reading code shows you patterns you would never invent alone.",
    "Open a small open source project and trace one feature.",
    "You will learn naming, structure and testing in one afternoon.",
    "So build small, finish often and read widely.",
    "That is the whole plan for your first ninety days.",
]
segments = []
for i, text in enumerate(LINES):
    start = i * 5.0
    words = text.split()
    step = 4.4 / len(words)
    segments.append({
        "start": start, "end": start + 4.5, "text": text,
        "words": [{"start": round(start + k * step, 3), "end": round(start + (k + 1) * step - 0.05, 3), "word": w} for k, w in enumerate(words)],
    })
json.dump({"language": "en", "segments": segments}, sys.stdout)
