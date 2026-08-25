#!/usr/bin/env bash
# Rebuild the teaser video from teaser.html. Requires python3 + playwright
# (`pip install playwright && playwright install chromium`) and ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"

FPS="${FPS:-30}"
DURATION="${DURATION:-39}"
OUT="${OUT:-../wickedways-teaser.mp4}"

echo "→ capturing frames"
python3 capture.py --fps "$FPS" --duration "$DURATION"

echo "→ encoding $OUT"
ffmpeg -y -framerate "$FPS" -i frames/f%05d.jpg \
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart "$OUT"

rm -rf frames
echo "→ done: $OUT"
