# Go-to-market reality check (Aug 2026)

> **Status:** the sequencing document. Written after an adversarial review of
> [`kickstarter-campaign-plan.md`](./kickstarter-campaign-plan.md) and
> [`tabletop-position-sensing-adr.md`](./tabletop-position-sensing-adr.md) disproved six load-bearing
> claims in them. Its job is to state, without varnish, **what has to be true before a campaign can
> launch** — and to stop the hardware docs from reading as launch-ready when they are not.
>
> **The headline: the Kickstarter is not the next step. It is two to three steps away, and the blocker
> is audience, not hardware.**

## The one number that governs everything

Crowdfunding outcomes for tabletop are dominated by the **pre-launch audience**, and the relationship
is quantified well enough to plan against:

- Opted-in email subscribers convert to backers at roughly **5–15%**.
- A campaign is considered launch-ready when **its list alone can raise 30% of goal in 24 hours**.
- Campaigns that hit 30% in the first 48 hours **almost always fund**; those that don't **almost never
  recover**.
- Most tabletop campaigns fail *before launch day* — in the quiet months that should have gone into
  audience building.

That converts a vague worry into an arithmetic gate:

> **max defensible goal ≈ (list size × conversion × average pledge) ÷ 0.30**

### Where the project actually stands

**Audience as of Aug 2026: under 100 subscribers.** The Mailchimp capture on `landing/index.html` is
real and wired, but it has been running against a "Coming Soon" page with nothing to try.

| Scenario | Raise implied | Day-one needed (30%) | Backers @ ~$150 avg | Subscribers needed @ 10% |
|---|---|---|---|---|
| **Today** | ~$2.5–7.5k ceiling | ~$750–2,250 | 5–15 | **~100 (current)** |
| Minimal modular-tile run | ~$50k | ~$15k | ~100 | **~1,000 — 10×** |
| Collector flagship, 500 units | **~$600k** | ~$180k | ~1,200 | **~12,000 — 120×** |

The numbered collector flagship at 500 units implies a **~$600k raise**. That is a top-decile tabletop
campaign (the 2025 median board-game raise was around **$187k**) attempted with a two-orders-of-
magnitude audience deficit and no prior campaign history. **It is not a near-term product.**

## The three prerequisites, in order

### 1. Deploy the playable client — the highest-leverage action available

It is the campaign's central claim *and* the fix for the audience problem, and it is currently unbuilt:

- `.github/workflows/docs.yml` deploys **only** the VitePress docs site.
- The root `Dockerfile` **does** build the wasm client + `wickedways-server` on one port — the hard part
  is done — but **no hosting config is committed** (no `fly.toml`, `vercel.json`, `netlify.toml`,
  `render.yaml`, compose, or k8s).
- The only public URL in the repo is the docs site. `landing/index.html` has **no play link**.

Nothing else on this list moves until a stranger can click a link and play. A free, instantly playable
horror game *is* the top-of-funnel; the "Coming Soon" page is currently asking people to subscribe to
an abstraction.

### 2. Grow the list to ~1,000 opted-in subscribers

That is the gate for even a modest campaign, and it is 10× the current figure. Instrument it: know the
number, its growth rate, and the play→subscribe conversion, because every funding decision downstream
is a function of it.

### 3. Write the launch campaign

The shipped content is Hollow House (**9 rooms, 13 exits, 2 named mobs, 1 NPC, 8 items, win/lose
conditions** — small but genuinely *complete*, not a mere test fixture), `covenant` (5 rooms, co-op),
and a 2-room default demo. Four of the six bootable campaigns are engine test fixtures.

A horror game is bought for its story. **The story is the product, and it is unwritten.**

## Two strategic corrections

### Lead with modular tiles, not the collector flagship

The modular-tile product (ADR Option C) should be the first hardware SKU, because it depends on **none**
of the three riskiest bets in the collector build:

| Risk | Collector flagship | Modular tiles |
|---|---|---|
| Large colour e-ink panel ($330–500, sole-source, 10–30 s full-board refresh) | **critical dependency** | not used |
| Transparent coil layer (unvalidated Q-factor; invented $35) | **critical dependency** | not used |
| Resonant powered mat (dead standard, custom RF) | optional (C1′) | not used |
| Implied raise | ~$600k | ~$50k |

It is also the better *product* idea — cheap printed art on the table, physical fog-of-war as the
absence of a tile, and expansion economics where every new tile pack deepens the deck for boards people
already own. Validate the sensing with the already-specced **~$60 Tier-0 smoke test** before spending
anything else.

### The market's reference price is ~$250, and the copy is aimed at the wrong people

**Chessnut Air retails ~$219–250** with a wood frame, LEDs, an app, and full piece recognition — the
same sensing capability, mass-produced, supported. Any Wicked Ways board is priced *against* that, and
chess brings a brand and player base that a new IP does not.

Separately: the campaign copy (including the mockup's proof strip) currently sells *deterministic
replay, a Rust core, golden-pinned tests*. Those are **engineering** virtues. The buyer of a horror
board game does not want them. Rewrite for players — dread, story, the table going dark — and keep the
engineering as credibility, not as the pitch.

## Recommended sequence

1. **Correct the docs** so nothing in the repo asserts a $190 panel, a 52% margin, a live demo, or a
   Fall 2026 hardware date. *(done — this review)*
2. **Deploy the demo.** Link it from `landing/`.
3. **Measure and grow the list** toward ~1,000.
4. **Write the launch campaign** to a showable vertical slice.
5. **De-risk hardware cheaply** — Tier-0 smoke test; modular tiles first; bench-spike the transparent
   coil only if the collector board is ever revived.
6. **Campaign** — only when step 3's number clears, sized by the arithmetic above rather than by cost.

## What this document does *not* say

The technical work is not the problem. The engine is real, deterministic, and tested; the bridge,
codec, and controller exist; the sensing choice is well de-risked by a shipping consumer comp; and the
modular-tile concept is genuinely strong. **The gap is commercial readiness, not engineering.** That is
a much better problem to have — but it will not be solved by more hardware design.
