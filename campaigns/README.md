# Campaigns

The authored campaign sources — every campaign is one TOML file in the
campaign-author format compiled by `wickedways-author`. **This is the directory to
start from if you want to write or modify a campaign.**

Two ways to work with these files:

- **Campaign Studio** (served at `/studio` on a deployed instance, or
  `dx serve` in `crates/wickedways-studio`): the graphical editor. Every file
  here is available in the studio as a template ("New from …" and the template
  gallery), and the studio imports/exports this exact TOML format.
- **By hand + the compiler**: edit the TOML, then compile and validate it with
  `wickedways_author::compile` (the author gate in
  `crates/wickedways-author/tests/gate.rs` shows the pipeline). The format is
  documented in `docs/` and by example — `hollow-house.toml` is the complete
  shipped campaign.

## What's here

| File | What it is |
|---|---|
| `hollow-house.toml` | **The Hollow House** — the shipped nine-room campaign; the fullest example of the format. |
| `covenant.toml` | **The Covenant** — the co-op multiplayer campaign (twin-ward victory needs two players). |
| `g2-*.toml` | Single-feature campaigns, one per engine mechanic (doors, mobs, scenes, victory, villain cards, …). Small, focused references for how each feature is authored — and the studio's template gallery. |

## Relationship to `conformance/fixtures/`

The golden corpus under `conformance/fixtures/` holds the **compiled output** of
these sources (description/catalog/genesis JSON) plus engine replay goldens —
regression pins, not sources. The gates compile the TOML here and hold the
result equal to those pins; regenerate them deliberately with
`UPDATE_GOLDENS=1` (see the root `CLAUDE.md`). Never edit the goldens by hand —
edit the TOML here and regenerate.
