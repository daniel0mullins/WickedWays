# Licensing and the moat (AGPL-3.0)

> **Status:** analysis, no decision made. Raised by the Aug 2026 commercial review, which found that
> the licensing question had never been considered against the hardware plan. **This is not legal
> advice** — it flags the decisions worth taking to a lawyer before money or hardware is committed.

## The facts on the ground

- **`LICENSE` is GNU AGPL-3.0**, verbatim FSF text. It is the repository's *only* licence file: no
  per-crate licence, no dual-licence grant, no commercial-licence document.
- **No trademark or ownership scaffolding exists.** A case-insensitive search across `*.md`, `*.toml`,
  and `*.html` for `trademark`, `™`, `all rights reserved`, `copyright (c) 20`, and `patent` returns
  **zero results**. There is no `NOTICE`, no `CONTRIBUTING`, no CLA, and no entity documentation.
- **"Wicked Ways" is a common English phrase.** Availability as a mark in the relevant classes (games,
  software, consumer electronics) is **unverified**.

## Why AGPL matters more for hardware than for a web app

AGPL's distinguishing feature is the network clause: users interacting with the software **over a
network** must be able to obtain its source. Two consequences the plan never accounted for:

1. **Shipping a device distributes the software.** Every board sold is a distribution, carrying the
   obligation to provide corresponding source to the purchaser. That is satisfiable — the source is
   already public — but it must be handled deliberately (written offer, versioned source per shipped
   firmware/build, and clarity about which components the obligation covers).
2. **A competitor can legally clone the product.** Anyone — plausibly a manufacturer with better
   supply-chain access, tooling, and unit economics than a solo creator — may take the engine, build
   equivalent hardware, and sell it, provided they publish their source. Given that the hardware is
   assembled from commodity parts (e-ink module, NFC reader, mux, MCU) and the *sensing* approach is
   already proven by shipping consumer products, **the software is not a defensible moat.**

This is not an argument against AGPL. It is an argument for knowing what the moat actually is.

## Where the moat actually lives

| Candidate moat | Protected by AGPL? | Real strength |
|---|---|---|
| Engine source | ❌ no — copyleft permits cloning | none |
| Sensing approach | ❌ no — prior art in e-chessboards | none |
| **Campaign content** (story, art, writing) | **potentially — see below** | **strongest** |
| **Brand / trademark** | ✅ separate regime, unregistered today | strong, currently unclaimed |
| Community & audience | n/a | strong, currently ~nil |
| Supply chain / tooling | n/a | weak at 500 units |

**Content is the asset.** A cloned engine without the campaigns is an empty shell — which reinforces
the go-to-market conclusion that the unwritten launch campaign is the actual product, not the hardware.

## Decisions worth taking to a lawyer

1. **Is campaign content a derivative work of the engine?** Campaign TOML/JSON is *data consumed by*
   the engine, which normally argues against derivation — but bundling authored content into a shipped
   binary or image muddies it. If content is meant to be proprietary (or separately licensed), state
   that explicitly in a licence header and keep the packaging boundary clean. Doing this **before**
   content is written is far cheaper than retrofitting.
2. **Dual-licensing.** Retaining copyright allows offering the engine under AGPL *and* a commercial
   licence. This is only possible while authorship is centralised — **outside contributors without a
   CLA make it effectively impossible later.** If dual-licensing might ever matter, add a CLA now.
3. **Trademark.** Clear and register "Wicked Ways" in the relevant classes before a public campaign
   puts the name in front of an audience. A crowdfunding launch is exactly when a name becomes worth
   contesting, and the phrase is generic enough that clearance is not assured.
4. **Entity and liability.** Selling a mains/battery-powered consumer electronic device to the public
   carries product-liability exposure. Certification (FCC/CE/UKCA, UN38.3) is a *legal* prerequisite,
   not just a cost line — and it should sit behind an entity, not an individual.
5. **Contributor policy.** No `CONTRIBUTING` or CLA exists today. Decide the posture before the project
   attracts contributors, because the decision is hard to reverse.

## Recommendation

**Keep AGPL for the engine** — it costs little that is actually defensible, and open source is a
credibility asset for exactly the technical audience the project already reaches. **Move the moat to
brand and content:** register the mark, keep authored campaigns under a distinct licence with a clean
packaging boundary, and add a CLA while authorship is still centralised. Revisit dual-licensing only if
a commercial licensee ever appears.

None of this is urgent relative to the audience problem in
[`go-to-market-reality.md`](./go-to-market-reality.md) — but items 2 and 3 (CLA, trademark) get
**strictly more expensive with time**, so they are worth doing early even while everything else waits.
