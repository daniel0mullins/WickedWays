# Wicked Ways — Kickstarter campaign plan

> **Status:** WIP planning doc. Brand voice/assets from [`landing/`](../landing/index.html) (*"A New
> Horror Awaits,"* Cinzel/Garamond, `@wickedways_vtt`, "Launching Fall 2026," Mailchimp list already
> live). The product is the **shipped Rust engine** (the wasm web client, real and playable today) plus
> the **collector e-ink board format** (see
> [`tabletop-position-sensing-adr.md` §Collector format](./tabletop-position-sensing-adr.md#collector-format-flagship-sku)).
>
> ⚠️ **The flagship launch campaign narrative is still WIP.** *Hollow House is a test fixture, not the
> headline story* — it appears here only as the **playable proof/demo**. Everywhere the plan needs the
> launch story, it's marked `TODO(launch-campaign)`.

## The pitch (hook)

**Wicked Ways is a turn-based horror RPG you can play tonight in your browser — and a hand-built
collector board that brings its darkness to your table.** A Game Master (the engine itself) drives a
party through a dungeon: fight what's in the dark, loot it, talk your way past it, and watch three
interlocking stats — Health, Energy, Sanity — bleed out. Rooms you haven't lit are *genuinely*
unreadable. Every die you roll is the die the engine obeys.

The one-liner for the KS header: **"A New Horror Awaits — now it has a body."**

## Why back it — the anti-vaporware anchor

Most hardware/game Kickstarters ask you to fund a *promise*. **The Wicked Ways engine is already
done and shipping.** It runs in any browser, it's deterministic (a game is a pure function of seed +
command-log, pinned by a golden-replay test corpus), and the physical-tabletop bridge that drives real
e-ink/NFC hardware is built and tested (`wickedways-tabletop`, `wickedways-controller --dry-run`).

**Lead the campaign with a playable demo** (Hollow House on the web client). Backers *play the actual
game* before pledging — the single strongest de-risker we have. What the money funds is therefore
narrow and legible: the **hardware production run** and the **flagship campaign's art + writing** — not
"will the software work."

## Why Kickstarter, why now

- **Fall 2026 timing** matches the landing page's existing promise, and the email list + socials are
  already capturing an audience to convert on day one.
- **The color e-ink panel needs MOQ pre-funding** — it's ~40% of unit COGS and orders at volume. A
  crowd both funds that buy and *validates demand* for a genuinely niche luxury object before we commit
  capital to panels.
- A **numbered limited run** is the right shape for a $850–1,200 collector piece: scarcity fits the
  price, and a bounded run bounds the fulfilment risk on heavy, fragile electronics.

## Reward tiers

Map 1:1 onto the SKU ladder in the ADR. Gothic names, plain-English contents.

| Tier | Pledge | What's in it | Notes |
|---|---|---|---|
| **The Curious** | $1 | Name in the in-game credits; digital wallpaper | Cheap funnel; grows the list |
| **Initiate** *(digital)* | ~$25 | The digital game + the launch campaign (`TODO(launch-campaign)`), all future updates | The volume tier; ~zero marginal fulfilment |
| **The Haunted** *(phone-glass board)* | ~$99 | Printed mat + NFC-tagged minis + LED darkness layer; art on your phone | The accessible physical entry (ADR "Better/Best" tiers) |
| **The Possessed** *(compact collector)* | ~$849 | 7.3″ **color e-ink** board, frontlit, NFC sensing, dice + tray | The compact flagship |
| **The Damned** *(flagship, numbered)* | ~$1,199 | 13.3″ color e-ink, self-contained (onboard engine), audio, sculpted set, numbered plate | The hero SKU |
| **The Coven** *(retail/group)* | bulk | Multiple digital + one board; FLGS/streamer pack | Optional; simplifies group buys |
| **Whale — "Architect of Ruin"** | high | Design-a-room in the launch campaign (with our writers) + flagship board | Cap at a small number; scarce & high-touch |

Pricing rationale and COGS live in the ADR. **Digital and phone-glass tiers carry the campaign's
volume; the collector tiers carry its identity** (and thinnest net margin — see risks).

## Funding goal (worksheet, not a wish)

Set the *public goal* to fixed costs + break-even on a **minimum viable collector run**, not the dream
number. Inputs we know vs. `TODO`:

| Line | Basis | Amount |
|---|---|---|
| Collector unit COGS | ADR BOM | ~$580 (flagship) / ~$440 (compact) |
| Flagship-campaign art + writing | `TODO(launch-campaign)` | `TODO` |
| Tooling — mini molds, enclosure, coil-layer lamination NRE | quotes needed | `TODO` |
| Certification (EMC/FCC/CE, battery/UN38.3) | one-time + per-region | `TODO` |
| Panel MOQ pre-buy | vendor quote | `TODO` |
| **Fee stack on raised funds** | KS ~5% + payment ~3–5% + failed-payment ~7–8% | plan **~15%** off the top |
| Fulfilment (heavy, fragile, insured) | per-unit, region-dependent | `TODO` — model separately, charge shipping at pledge |
| Contingency buffer | hardware always slips | **+15%** |

Rule of thumb: **goal = (fixed costs + tooling + cert + campaign art) ÷ (1 − fee% − buffer%)**, chosen
so a *modest* number of collector units + the digital/phone volume clears it. Charge shipping as a
separate post-campaign step (BackerKit-style) so fragile-freight variance doesn't eat the pledge.

## Stretch goals (with a logistics caveat)

Prefer stretch goals that add **content, not fulfilment complexity** — every physical add-on multiplies
pick-pack and freight on an already-heavy box:

- ✅ Low-risk: extra digital campaigns, an in-app soundtrack, extra scripted encounters, a second
  language for the digital game.
- ⚠️ Medium: an extra mini set, upgraded metal dice (bagged with the board).
- ❌ Avoid: separately-shipped electronics, region-specific hardware variants, anything that forks the
  BOM mid-campaign.

## Timeline

1. **Pre-launch (now → launch):** grow the existing list with the playable demo as the lead magnet;
   build the KS page + video; line up panel/mini/cert quotes to fill the `TODO`s above.
2. **Campaign — 30 days.** Front-load: playable demo + numbered-tier scarcity on day one.
3. **Post-campaign:** BackerKit for shipping + address + late pledges.
4. **Production:** color e-ink panels are **long-lead** — order against locked funds first; cert and
   hand-assembly in parallel. Set backer expectations to a realistic delivery **quarter**, padded by the
   contingency buffer. (Software is done, so *that* usual KS slip risk is absent — say so.)

## Risks & challenges (Kickstarter requires this — and it's genuinely the crux)

- **Panel supply & price.** The hero component; single-vendor risk. *Mitigation:* pre-buy against
  locked funds, hold the compact 7.3″ SKU as a fallback if 13.3″ pricing moves.
- **Certification.** A sold electronic device with a battery + RF needs EMC/FCC/CE + UN38.3. *Mitigation:*
  budget it as a named fixed cost; a USB-powered (no internal cell) variant drops the battery cert.
- **Fragility & warranty.** The panel is ~40% of COGS; a cracked board is a costly return. *Mitigation:*
  protective enclosure, service-swap program, insured freight.
- **Fulfilment of heavy/fragile electronics.** Thin *net* margin despite healthy gross. *Mitigation:*
  shipping charged separately at cost; numbered run caps exposure.
- **Software risk: low, and that's the story.** The engine ships today; backers play it pre-pledge.
- **Narrative readiness.** `TODO(launch-campaign)` — the flagship story must be far enough along to
  *show* (art, tone, a vertical slice) before launch, or the campaign leans too hard on the tech.

## Pre-launch checklist

- [ ] `TODO(launch-campaign)` — flagship narrative to a showable vertical slice (this gates launch)
- [ ] Playable web demo polished as the KS lead magnet (Hollow House proof)
- [ ] KS pre-launch page live; drive the existing Mailchimp list + `@wickedways_vtt` to "notify me"
- [ ] Vendor quotes to fill the funding worksheet `TODO`s (panels, molds, cert, lamination NRE)
- [ ] Campaign video (playable footage > renders — we have a real game, show it)
- [ ] Fulfilment partner for heavy/fragile freight; BackerKit set up for shipping
- [ ] Photography of a working collector prototype (the coil-over-frontlight stack running)

## Open / TODO

- **`TODO(launch-campaign)`** — the entire flagship story (Hollow House is only the demo).
- Legal/brand entity, tax/VAT handling per region, fulfilment partner selection.
- Final pledge prices vs. the ADR anchors (adjust once tooling/cert quotes land).
- Whether a working collector prototype exists in time to film — or the campaign launches on the compact
  SKU + phone-glass tiers and treats the flagship 13.3″ as a stretch/limited add-on.
