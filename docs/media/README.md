# Media

Marketing and presentation assets. Talk decks live in [`docs/talks/`](../talks/).

## `wickedways-teaser.mp4`

A 39-second teaser: 1280×720, H.264, ~2.9 MB, **silent** (so it plays in
muted-autoplay feeds). Seven beats — the cold open, the stat triangle, the
darkness/lantern decision, the d20, "one game, every table", the campaign file,
and the title card.

The video is **generated, not hand-edited**. Its source is
[`teaser/teaser.html`](teaser/teaser.html): one page whose every visual is a
pure function of time, exposed as `window.renderFrame(t)`. Nothing depends on
wall-clock time or CSS animation, so a capture is exactly reproducible — the
same source always yields the same frames.

### Rebuilding

```bash
pip install playwright && playwright install chromium   # once
docs/media/teaser/build.sh                              # ~90 seconds
```

`build.sh` steps the animation frame-by-frame through headless Chromium, then
encodes with ffmpeg and cleans up the frames. Override with environment
variables:

```bash
FPS=60 DURATION=39 OUT=../teaser-60fps.mp4 docs/media/teaser/build.sh
```

Other cuts come from the same source — a vertical 9:16 version needs the
viewport changed in `capture.py` (`--width 720 --height 1280`) and the layout
coordinates in `teaser.html` adjusted to match; a shorter cut means trimming
`DURATION` and the scene table (`SC`) at the top of the script block.

### Reference frames for video generation

[`teaser/shot-list.md`](teaser/shot-list.md) breaks the teaser into its seven
beats, each with reference frames and a prompt written for a text-to-video
model — for regenerating the beats as filmed plates under the existing type
layer. Render the frames with `python3 teaser/refshots.py` (1920×1080, two per
beat); they are derived artifacts and are not committed.

### Editing the content

Copy, timings, and motion all live in `teaser.html`:

- **`SC`** — the scene table: `[start, end]` in seconds, one row per beat.
- **`renderFrame(t)`** — one block per scene, each computing opacity, transform,
  and typewriter progress from `t`.
- The palette matches the talk decks (`--ink`, `--bone`, `--gold`, `--red`).

Fonts are restricted to families that ship with most Linux installs (DejaVu,
Liberation) so a rebuild on another machine renders identically to this one.
