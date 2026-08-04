# Wicked Ways — visual assets brief (image-generation prompts)

> Prompts for the Kickstarter/marketing imagery of the collector board (see
> [`kickstarter-campaign-plan.md`](./kickstarter-campaign-plan.md) and the
> [campaign-page mockup](./kickstarter-campaign-mockup.html)). Tuned to the brand's identity:
> lantern-amber light in a warm-black void, aged bone, a rare oxblood note. Keep the **style suffix**
> identical across every generation — that cohesion is what makes the set read as one campaign.

## Style suffix (append to every prompt)

```
STYLE: gothic horror product photography, cinematic chiaroscuro, single warm
lantern light source, deep shadows, near-black warm-charcoal background (#0a0908),
aged-bone highlights (#d8cfc0), one amber accent glow (#e8a94a→#c8702f), rare
oxblood-red note (#7a2420). Reflective surfaces, faint film grain, volumetric
haze, candlelit. Muted, desaturated except the amber glow. Shot on 50mm, f2,
shallow depth of field. No bright colors, no daylight, no clutter.
```

**Negative prompt (SD/Flux) / `--no` list (Midjourney):**

```
daylight, bright, colorful, saturated, plastic, toy-like, cartoon, low detail,
watermark, text, logos, gaudy, neon, blue tint, cluttered, busy, cheap
```

**Params & consistency**

- Aspect: hero/beauty `--ar 16:9` or `3:2`; the object alone `--ar 4:5`; cutaway `--ar 3:2`;
  web-background plate `--ar 21:9`.
- Midjourney: add `--style raw --v 6`.
- **Cohesion:** generate the hero first, then reuse it as a style reference (MJ `--sref`, or img2img at
  low strength) and **lock one seed** across the whole set.
- Two failure modes to steer around: (1) generators drift e-ink toward a glowing LCD — counter with
  "matte, reflective, paper-like, ink on the surface, no backlight glow"; (2) they can't spell — keep
  all real copy (title, prices, edition numbers) **out** of prompts and add it in post.

---

## Scene prompts

### 1 · Hero — the board in play

```
A luxury tabletop horror game board on a dark oak table in a dim candlelit room.
The board is a single large color e-ink panel, its matte reflective surface
showing a hand-inked antique gothic dungeon map of shadowed stone rooms. A warm
dimmable frontlight glows across the surface like lantern light. Three finely
sculpted resin miniatures — a hooded explorer, a lantern-bearer, a lurking horror
— stand on the map. Beyond the pool of light the far rooms fall into true black,
unreadable. A small brass lantern prop casts the glow. Overhead three-quarter
angle, hands just out of frame. Ominous, intimate, expensive.
```

### 2 · Cutaway — the layered stack (exploded technical view)

```
An elegant exploded technical cutaway illustration of a premium electronic game
board, layers floating apart and stacked in perspective, thin amber connector
lines between them. Top to bottom: sculpted miniature on a base, a sheet of clear
cover glass, a fine transparent copper coil grid, a glowing warm frontlight guide
panel, a color e-ink display showing a gothic map, a dark wood-and-resin enclosure
with a small speaker and a circuit board. Blueprint-meets-grimoire aesthetic,
precise, on near-black. Warm amber edge-lighting on each layer.
```

> The one asset where a hand-built diagram may beat AI. Generate it clean, then add the
> `01 Cover glass / 02 Coil grid / …` callouts in Figma/Canva — the CSS cross-section in the campaign
> mockup is a usable layout reference for label order.

### 3 · Beauty shot — the object, powered off

```
Product beauty shot of a closed luxury collector board game, a single object:
a 13-inch color e-ink panel framed in dark walnut and black resin, a small
engraved brass number plate reading a low edition number, magnetic lid ajar,
fitted black foam interior cradling metal dice and miniatures. Matte and brass
materials, one warm rim light from the left, everything else in shadow.
Museum-catalog styling, floating on seamless near-black. Heirloom, occult, premium.
```

### 4 · The darkness mechanic — before/after light

```
Same gothic e-ink game board shown split by light: the near half brightly washed
by warm lantern frontlight revealing detailed inked rooms and a miniature; the far
half in genuine reflective darkness, the map dissolving into unreadable black.
A hard falloff between lit and unlit, like a lantern's edge. Dramatic, eerie,
demonstrating that unlit rooms literally cannot be read.
```

### 5 · Detail — dice tray & pieces

```
Extreme close-up macro: heavy metal polyhedral dice, a natural 20 face up, resting
in a carved reading tray beside a sculpted resin miniature with an NFC disc set into
its felt base. Warm amber light raking across brushed metal and matte resin, dust
motes in the haze, deep shadow behind. Tactile, luxurious, tense.
```

### 6 · Atmospheric web-background plate (hero section)

```
Abstract atmospheric texture: warm amber lantern glow bleeding into vast warm-black
darkness, faint drifting haze and film grain, a single soft pool of light off-center,
edges falling to pure near-black. No objects, no text. Moody, cinematic, seamless,
usable as a dark website hero background.
```

---

## Hero variations (A/B the key visual)

Same style suffix; three different compositions of the money shot.

### A · Top-down flat-lay

```
Directly overhead flat-lay of the luxury horror game board centered on a dark oak
table: a single color e-ink panel showing a hand-inked gothic dungeon map, warm
frontlight pooling at the center and falling to black at the edges, sculpted resin
miniatures and a brass lantern prop placed across the rooms, metal dice in a carved
tray at one corner. Symmetrical, graphic, catalog-perfect. Everything beyond the
lit rooms dissolves into true darkness.
```

### B · Players' hands in frame (the human moment)

```
Low three-quarter shot across a candlelit table: two players' hands reaching over
the glowing e-ink horror board — one placing a sculpted miniature into a dimly lit
room, the other cupping a metal d20. Warm frontlight underlighting their hands,
faces out of frame, tense body language. The board's far rooms lost to black.
Intimate, cinematic, a real game night in the dark.
```

### C · One lit room in a black void (moodiest)

```
A single glowing room on the e-ink board isolated in a vast black void — the
frontlight revealing only one inked chamber and one hooded miniature within it,
everything around it total darkness with no visible table edges. A faint amber halo,
heavy grain, dread and isolation. Minimal, poster-like, the loneliest square of
light in the house.
```

**Pick guidance:** A reads as *premium object* (best for the object/collector story), B as *shared
experience* (best for "get people off their phones"), C as *pure horror mood* (best for the teaser /
social top-of-funnel). Test all three against the campaign's hero and the ad set.
