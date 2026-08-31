#!/usr/bin/env python3
"""Capture the teaser animation frame-by-frame with headless Chromium.

The animation is deterministic: `teaser.html` exposes `window.renderFrame(t)`,
which paints the frame for time `t` (seconds) with no reliance on wall-clock or
CSS animation. We step it ourselves, so the capture is exactly reproducible and
independent of how fast the machine renders.

Usage:  python3 capture.py [--fps 30] [--duration 39] [--out frames]
Set CHROMIUM_PATH to pin a specific Chromium build; otherwise Playwright's own
browser is used (`playwright install chromium`).
"""
import argparse
import os
import pathlib
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent

parser = argparse.ArgumentParser()
parser.add_argument("--fps", type=int, default=30)
parser.add_argument("--duration", type=float, default=39.0)
parser.add_argument("--width", type=int, default=1280)
parser.add_argument("--height", type=int, default=720)
parser.add_argument("--out", default=str(HERE / "frames"))
args = parser.parse_args()

out = pathlib.Path(args.out)
out.mkdir(parents=True, exist_ok=True)
for stale in out.glob("f*.jpg"):
    stale.unlink()

frames = int(args.fps * args.duration)
launch = {"args": ["--force-color-profile=srgb", "--font-render-hinting=none",
                   "--disable-lcd-text", "--hide-scrollbars"]}
if os.environ.get("CHROMIUM_PATH"):
    launch["executable_path"] = os.environ["CHROMIUM_PATH"]

started = time.time()
with sync_playwright() as pw:
    browser = pw.chromium.launch(**launch)
    page = browser.new_page(viewport={"width": args.width, "height": args.height},
                            device_scale_factor=1)
    page.goto((HERE / "teaser.html").as_uri())
    page.wait_for_timeout(700)  # let fonts settle before the first frame
    for i in range(frames):
        page.evaluate("t => window.renderFrame(t)", i / args.fps)
        page.screenshot(path=str(out / f"f{i:05d}.jpg"), type="jpeg", quality=94)
        if i % 150 == 0:
            print(f"  {i}/{frames}  ({time.time() - started:.0f}s)", flush=True)
    browser.close()

print(f"captured {frames} frames in {time.time() - started:.0f}s -> {out}")
