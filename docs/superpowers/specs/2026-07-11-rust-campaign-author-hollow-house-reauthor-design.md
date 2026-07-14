# Rust Campaign Author (G2) — Full Hollow House re-author (capstone) design

**Date:** 2026-07-11
**Status:** design, implemented
**Predecessor:** G2 description-structure surface completion (`docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md`), merged via PR #67.

## Context

With the expression and description surfaces complete, the author can express every field the real
Hollow House uses. This capstone proves it end-to-end: the ENTIRE shipped campaign re-authored in one
`conformance/fixtures/hollow-house.toml`, gated so `compile()` reproduces the committed
`hollow-house.{description,catalog}.json` (the real serialized campaign) **byte-for-byte**. Unlike the
per-slice `g2-*` oracles (each a focused fragment), this exercises the whole surface at once: 9 rooms
(some dark, some spawn-biased), 13 exits (3 keyed doors with name + initialState), 2 mobs, 4 loot
containers, 1 NPC, 2 formations, 1 scene, 3 mechanics (dread / the full-lore storyteller / status-bar),
3 victory conditions, 8 items, plus opts + timeout.

The committed `hollow-house.{description,catalog}.json` ARE the oracle (emitted by the real TS campaign),
so no new generator is needed — only the hand-authored TOML and two Rust gate tests.

## Two surface additions the capstone forced

1. **Double-quoted string literals.** The storyteller's lore strings contain apostrophes (e.g.
   `'They would not…'`), which the single-quote-only lexer could not carry. The lexer now accepts `'…'`
   OR `"…"`; a string with one quote kind is written with the other. This rippled into the statement-
   level scanners (`split_args`/`split_top_level`/`find_open_brace`/`matching_brace`/`find_assignment_eq`
   and `damage_body`'s ternary scanners), which now track both quote kinds via a shared `track_quote`
   helper — a double-quoted lore string full of apostrophes and commas no longer mis-splits.

2. **Item `aliases`.** The real catalog carries per-item name aliases (`lantern: [lantern, lamp, light]`).
   `ItemEntry` gains an `aliases` list, lowered into `catalog.aliases[<key>]`.

## One surface change the capstone forced

**Win/lose conditions are now an array of tables.** The real campaign's `loseConditions` are
`[sanity-zero, party-down]` — declaration order, NOT alphabetical — which a `BTreeMap`-keyed
`[victory.win.<key>]` surface (sorted) cannot reproduce. The surface changes to `[[victory.win]]` /
`[[victory.lose]]` with an explicit `key`, preserving author order. The `g2-vault`/`g2-victory` oracle
TOMLs (and the README example) are updated to the new syntax; their goldens are unchanged.

## Constraints held

- Byte-parity is the acceptance criterion; the committed fixtures are the authority.
- Panic-free; no `compile()` signature change; no ts-rs binding change.
- Determinism gated (`compile(hollow-house.toml)` twice → identical).

## What remains

Only packaging: id-derivation for `giveItem`/`setVisible` + computed dialogue responses, npx/WASM CLI
packaging, and runtime-load of a compiled campaign.
