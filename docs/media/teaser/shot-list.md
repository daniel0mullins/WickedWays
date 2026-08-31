# Teaser shot list — reference frames + video-generation prompts

Seven beats from [`teaser.html`](teaser.html), each with reference frames and a
prompt written for a text-to-video model (Veo, Sora, Runway, Kling, Pika).

Two frames per beat: **-a** is the beat opening, **-b** is its payoff. Regenerate
them any time with `python3 refshots.py` (1920×1080).

## How to use this

**Generate silent plates, not finished shots.** Text-to-video models render
lettering unreliably — words warp, letters invent themselves. Every line of copy
in this teaser already exists as a crisp, deterministic layer in `teaser.html`.
So: generate the *footage* for each beat with no text in it, then composite the
existing type layer over it. You keep perfect typography and gain filmed imagery.

**The reference frames do two jobs.** As an image prompt they anchor palette and
composition; as a style reference across all seven shots they keep the beats
looking like one film. Feed the same frame for a beat plus the shared style block
below into every generation.

**Shot lengths** are given per beat and match the current cut, so generated
plates drop straight onto the existing timeline.

## Shared style block

Paste this into every prompt, before or after the shot description:

> Cinematic horror teaser, late-Victorian haunted house interior. Single warm
> candle/lantern key light, everything else falling into near-black. Colour
> limited to near-black violet (#0E0B14), bone white (#E9E2D0), tarnished gold
> (#C9A227), dried-blood red (#8E2F2F). Heavy vignette, fine 35mm grain, shallow
> depth of field, slow deliberate camera. No on-screen text, no titles, no
> captions, no watermarks, no lens flare, no modern objects. 16:9, 24fps.

**Negative prompt:** `text, letters, subtitles, watermark, logo, modern clothing, bright daylight, saturated colours, fisheye, fast cuts, jump cuts, people looking at camera, cartoon, CGI sheen`

---

## Beat 1 — Cold open · 0:00–0:05 (5s)

**Frames:** `s1-a.jpg` (line one), `s1-b.jpg` (line two)
**Copy (overlay):** "The door thuds shut behind you." → "Something in the cellar has been waiting."
**What the current animation does:** black frame, a candle glow flickers up from centre, the first line types on, then a quieter second line fades in beneath it.

> **Prompt:** Interior night. A heavy oak door swings shut and seals a dark
> entrance hall, punching dust into the beam of a single guttering candle. The
> camera pushes in slowly on the closed door as the last daylight narrows to
> nothing at the threshold. Almost imperceptible handheld drift. Warm amber key
> from screen left, cold blue-black fill everywhere else.

*Leave the centre of frame uncluttered — the copy sits there.*

---

## Beat 2 — The stat triangle · 0:05–0:11 (6s)

**Frames:** `s2-a.jpg` (circles landing), `s2-b.jpg` (cycle complete)
**Copy (overlay):** "THREE THINGS KEEP YOU ALIVE" → "Each one guards the next. Let one fall — and the house pushes."
**What the current animation does:** three rings — Health, Sanity, Energy — pop in as a triangle, then gold arrows draw one by one around the cycle.

This beat is a diagram, so it needs a *filmable metaphor* rather than a literal translation. Two options:

> **Prompt A (candles):** Three candles stand in a triangle on a dark mantel.
> The first gutters and dims; as it fades, an ember travels along an invisible
> line to the second, which flares to keep it alive; then the third. A slow
> circling dolly around the three flames. Macro, extreme shallow focus, amber on
> near-black.

> **Prompt B (character):** Close on a woman's face in candlelight, jaw set,
> holding steady — then a flicker of fear crosses her eyes and she suppresses
> it, breathing out slowly. Camera almost static, very slow push in. Half the
> face in shadow.

*Prompt A stays abstract and cuts cleanly with the diagram overlay; Prompt B is
warmer but commits the teaser to a specific character.*

---

## Beat 3 — Darkness · 0:11–0:17 (6s)

**Frames:** `s3-a.jpg` (dark room, contents hidden), `s3-b.jpg` (lit, eyes open)
**Copy (overlay):** "THE DARK IS A DECISION" → "It hides what is in it — and something in there sees you fine."
**What the current animation does:** a black room panel holds a single "?", then lantern light floods it warm and two red eyes open at its centre.

> **Prompt:** A pitch-black stone cellar. A hand raises an oil lantern into
> frame from below; the light blooms outward and reveals damp walls and a low
> arch — and at the very edge of the light, two small red eye-reflections open
> and hold, unblinking, low to the ground. The lantern flame wavers; the eyes do
> not move. Slow push in, focus racking from the lantern glass to the far dark.

*This is the money shot of the first half — worth several generations.*

---

## Beat 4 — The d20 · 0:17–0:23 (6s)

**Frames:** `s4-a.jpg` (mid-tumble), `s4-b.jpg` (20, gold flare)
**Copy (overlay):** "EVERY ATTACK OPENS WITH A d20" → "CRITICAL HIT ×1.5" → "Roll your own dice. The game takes your number."
**What the current animation does:** the die face cycles through numbers as it spins, slams to 20, and flares gold.

> **Prompt:** Macro shot: a heavy antique metal twenty-sided die tumbles across
> a scarred wooden table in candlelight, bouncing twice and settling with the
> 20 face upward. As it lands the candle flame surges and gilds the engraved
> numeral. The final rotation is in extreme slow motion; dust hangs in the light.
> Locked-off camera, very shallow depth of field.

*Models often mangle engraved numerals. Generate the roll, and if the landed "20"
comes out wrong, hold on the tumble and let the overlay carry the number.*

---

## Beat 5 — One game, every table · 0:23–0:28 (5s)

**Frames:** `s5-a.jpg` (spokes drawing), `s5-b.jpg` (all four lit)
**Copy (overlay):** "One game. Every table."
**What the current animation does:** a red core lights at centre and four spokes draw outward to BROWSER, DESKTOP, ONLINE and A REAL BOARD.

> **Prompt:** Slow overhead dolly down onto a dark wooden table. The same
> candlelit map of a haunted house is visible in four places at once: glowing on
> a phone lying flat, on a laptop screen at the table's edge, on a tablet
> propped up showing a video call, and painted across a physical board of pale
> tiles at the centre with small pewter figures on it. Each surface brightens in
> turn with the same amber light, in sync. Warm practical light only.

*The one beat where a modern object is wanted — the phone and laptop are the
point. Drop "no modern objects" from the negative prompt for this shot.*

---

## Beat 6 — Write your own · 0:28–0:33 (5s)

**Frames:** `s6-a.jpg` (two lines in), `s6-b.jpg` (payoff line)
**Copy (overlay):** the campaign file — `ROOM The Cellar` / `DOOR Iron Door — needs: cellar key` / `RULE Doom clock — ticks each round` → "Write your own nightmare."
**What the current animation does:** three monospace lines type themselves out.

> **Prompt:** Close on a hand writing with a dip pen in a leather-bound ledger
> by candlelight — a floor plan sketched on the left page, a list of rules
> forming on the right. As each line is finished the ink briefly glows amber,
> and in the blurred dark beyond the desk a door swings quietly open in
> response. Macro, shallow focus, dust motes, warm lamp.

*Generate the writing hand and the door reveal; keep the actual file text as the
overlay so it stays readable and correct.*

---

## Beat 7 — Title card · 0:33–0:39 (6s)

**Frames:** `s7-a.jpg` (title in), `s7-b.jpg` (full card)
**Copy (overlay):** WICKED WAYS · "A co-op horror RPG that follows you anywhere" · hollow.wickedways.online
**What the current animation does:** the title fades up as its letter-spacing tightens, then the tagline and links appear beneath.

> **Prompt:** Black. A single candle flame drifts into the lower third of frame
> and steadies, its light falling across a dark embossed surface — leather or
> tarnished brass — with the texture just readable. The camera is nearly locked
> off; only the flame moves, in a slow flicker cycle. The upper two-thirds of
> frame stay in deep shadow.

*Composition matters more than content here: keep the top two-thirds clean for
the title lock-up.*

---

## Assembling the result

1. Generate each beat as a silent plate at the length above.
2. Drop the plates onto the timeline in place of the current backgrounds.
3. Composite the type layer from `teaser.html` over them — capture it with
   `capture.py` against a transparent or green background if your editor needs a
   matte.
4. Keep the existing cut lengths; they are already paced for the copy.
5. Grade the plates toward the shared palette so all seven beats match, and
   carry one continuous grain and vignette across the whole piece.
