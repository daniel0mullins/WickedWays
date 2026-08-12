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
>
> **Companion assets:** a page-design concept ([`kickstarter-campaign-mockup.html`](./kickstarter-campaign-mockup.html)
> — open in a browser) and the image-generation brief ([`assets-brief.md`](./assets-brief.md)).
>
> ⚠️ **NOT READY TO LAUNCH — read [`go-to-market-reality.md`](./go-to-market-reality.md) first.**
> An August 2026 review found the blocker is **audience**: under 100 subscribers as of Aug 2026,
> against an evidence-based requirement of ~1,000 for even a modest campaign. The strategy below is
> sound *in shape*; treat it as the plan for a campaign that is **a step or two away**, not the next
> step.
>
> ✅ **The playable demo does exist** — an earlier draft of this warning wrongly listed it as missing.
> The project deploys via **Coolify** (per-PR previews plus a public production URL), configured
> out-of-band rather than in-repo, which is why a repository-only search missed it. So the
> anti-vaporware pillar below is a **true claim**; the remaining gap is that `landing/` doesn't link
> to it.

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

> ✅ **This pillar is real — the demo is deployed and publicly playable.** The project deploys through
> **Coolify** (per-PR preview environments plus a public production URL), configured in the PaaS rather
> than in the repository. An earlier draft of this note claimed the opposite, on the mistaken inference
> that no in-repo hosting config meant no deployment; see
> [`go-to-market-reality.md`](./go-to-market-reality.md).
>
> **One gap remains:** `landing/index.html` is still a "Coming Soon" capture page with **no play
> link**, so visitors are asked to subscribe without being offered the game. Linking it is hours of
> work and the cheapest available conversion win. **TODO:** record the canonical public play URL here.

## Why Kickstarter, why now

- ⚠️ **Fall 2026 is the *software* launch, not this campaign** (confirmed Aug 2026). The landing page's
  "Launching Fall 2026" refers to the digital game. **The hardware campaign has no committed date**, and
  should not acquire one until the audience gate in
  [`go-to-market-reality.md`](./go-to-market-reality.md) is cleared. The email list exists and is wired
  to Mailchimp, but at **under 100 subscribers** it cannot yet "convert on day one" in any meaningful
  volume.
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
| **Fee stack on raised funds** | ⚠️ corrected: KS **5%** + Stripe **~3% + $0.20/pledge** = **~8–10% in actual fees**. Dropped pledges are *lost revenue*, not a fee; budgeting ~15% all-in for fees + drops is still a reasonable planning number, but the two must not be conflated. | fees **~8–10%**; plan ~15% incl. drops |
| Fulfilment (heavy, fragile, insured) | per-unit, region-dependent | `TODO` — model separately, charge shipping at pledge |
| Contingency buffer | hardware always slips | **+15%** |

Rule of thumb: **goal = (fixed costs + tooling + cert + campaign art) ÷ (1 − fee% − buffer%)**, chosen
so a *modest* number of collector units + the digital/phone volume clears it. Charge shipping as a
separate post-campaign step (BackerKit-style) so fragile-freight variance doesn't eat the pledge.

> ⚠️ **This formula is necessary but not sufficient — and on its own it is circular.** It computes what
> you *need*, never what backers will *give*. The binding constraint is the audience, and it is
> testable: opted-in subscribers convert at **5–15%**; a campaign is launch-ready when its list alone
> raises **30% of goal in the first 24 hours**; campaigns that miss 30% in 48 h *almost never recover*.
> So the real rule is **goal ≤ (list size × conversion × average pledge) ÷ 0.30** — and the costs-based
> figure must come in *under* that ceiling, not above it.
>
> | Scenario | Raise implied | Day-one needed (30%) | Backers @ ~$150 avg | Subscribers @ 10% conv. |
> |---|---|---|---|---|
> | **Today (<100 subs)** | ~$2.5–7.5k max | ~$750–2,250 | 5–15 | **~100 (current)** |
> | Minimal modular-tile run | ~$50k | ~$15k | ~100 | **~1,000 (10×)** |
> | Collector flagship, 500 units | **~$600k** | ~$180k | ~1,200 | **~12,000 (120×)** |
>
> The 500-unit numbered flagship implies a **~$600k raise** — a two-orders-of-magnitude audience gap.
> Full reasoning and the recommended sequence: [`go-to-market-reality.md`](./go-to-market-reality.md).

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
- **Software risk: low, and that's the story.** The engine ships today — but ⚠️ **only as source**, and
  "backers play it pre-pledge" is blocked until the client is actually deployed (see above).
- **Narrative readiness.** `TODO(launch-campaign)` — the flagship story must be far enough along to
  *show* (art, tone, a vertical slice) before launch, or the campaign leans too hard on the tech.
- ⚠️ **Audience risk — currently the largest, and the plan's true blocker.** Under 100 subscribers.
  Evidence says most board-game campaigns fail *before* launch day, in the months the creator should
  have spent building an audience. No amount of hardware readiness compensates.
- ⚠️ **Content risk.** Shipped playable content today is Hollow House (9 rooms, 2 mobs, 1 NPC, 8 items
  — small but genuinely complete), `covenant` (5 rooms), and a 2-room default demo. The launch campaign
  does not exist. A horror game is sold on its story; that is the product, and it is unwritten.
- ⚠️ **Positioning risk.** The engine's virtues (deterministic, Rust, golden-pinned replay) are
  *engineering* virtues. Horror-game buyers don't buy those. The campaign copy — including the mockup's
  proof strip — currently markets to engineers. Rewrite for players before launch.
- ⚠️ **Cloneability (AGPL).** The engine is AGPL-3.0, so a competitor with better supply-chain access
  can legally build the same product if they publish source. The moat has to be brand, content, and
  execution — see [`licensing-and-moat.md`](./licensing-and-moat.md).

## Pre-launch checklist

**Gates (nothing below matters until these clear):**

- [x] ✅ **Publicly playable client deployed** (Coolify: per-PR previews + a public production URL).
- [ ] **Link the demo from `landing/`** and record its canonical URL — the game is live but the
      marketing page doesn't point at it. Cheapest conversion win available.
- [ ] 🛑 **Grow the list to ~1,000 opted-in subscribers** (from <100). This gates any campaign.
- [ ] `TODO(launch-campaign)` — flagship narrative to a showable vertical slice (this gates launch)

**Then:**

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
