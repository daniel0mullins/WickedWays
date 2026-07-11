# Rust Campaign Author (G2) — Description-structure surface completion design

**Date:** 2026-07-11
**Status:** design, implemented
**Predecessor:** G2 expression/effect surface completion (`docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-expression-surface-design.md`), merged via PR #66.

## Context

The expression/effect/statement surface is complete, so any *behavior* is authorable. But the
author still hardcoded most of the campaign *structure*: a gap analysis against `CampaignDescription`
found 11 fields emitted as `Vec::new()`/`None`/`default()` regardless of input (opts, archetypes,
mobs, caches, formations, recipes, materials, timeout/ended narration, chat, av) and 2 partial (rooms
dropped `dark`/`spawnModifier`/`lights`; exits dropped `name`/`initialState`), plus the item
descriptor dropping `slot`/`emitsLight`/`maxDurability`/`lore`/`equippable`/`droppable`/`twoHanded`.

This design closes the gap needed to **re-author the real Hollow House**, in eight slices. Every slice
is exercised by the real campaign, so each oracle authors the *real* content (not a stub) byte-for-byte.
The fields Hollow House does not use — `endedNarration`, `chat`, `av`, `caches`, standalone
`materials`/`recipes`, room `lights`, item `presentation`, mob override fields — stay deferred (they'd
need bespoke oracles).

## The eight slices

1. **Archetypes** (`g2-archetype`) — `[[archetypes]]` → `ArchetypeDef` (id/name/`baseStats` (`PartialStats`)/
   inventorySlots/immunities). Oracle: the real Heir, with a PC seated as it.
2. **Full item descriptor** (`g2-equipment`) — `ItemEntry` + `lower_item` read
   equippable/droppable/slot (`SlotKind`)/twoHanded/emitsLight/maxDurability/lore. Oracle: the real
   lantern (weapon/hand/emitsLight), poker (durable weapon), journal (the exact `JOURNAL_LORE` +
   droppable:false). `presentation` stays `None` (unused).
3. **Placed mobs** (`g2-mobs`) — `[[mobs]]` → `MobDef` (stats reuse the npc `Stats` type;
   natural_attack/material_drops are inert `toml→json`). Oracle: the real Wraith + Revenant.
4. **Room dark + spawnModifier** (`g2-dark-rooms`) — `RoomEntry` gains `dark`/`spawnModifier`/`lights`,
   read in the room lowering.
5. **Exit name + initialState** (`g2-exit-state`) — `ExitEntry` gains `name`/`initialState`
   (`toml→json`). Oracle: the real keyed door.
6. **Formations** (`g2-formations`) — the biggest: one `[[formations]]` entry carries BOTH halves —
   the description opt-in (`FormationDef {key, weight}`) and the catalog `FormationDescriptor` (its
   `mobs` roster deserializes straight into the core `MobSpec`). Oracle: the real roving rats.
7. **Campaign opts** (`g2-opts`) — the `[opts]` table deserializes straight into `CampaignOpts`.
   Oracle: the real `maxRounds: 150`.
8. **Timeout narration** (`g2-timeout`) — a `timeoutNarration` string lowers to the `{ text }` cue
   shape. Oracle: the real `.onTimeout`.

## Key decisions

- **Core types deserialize directly.** `MobSpec`/`FormationDescriptor`/`CampaignOpts` derive
  `Deserialize` (camelCase), so the surface reuses them rather than defining parallel structs. TOML
  integers deserialize into `f64` fields (`power = 1`) fine.
- **Bigints in the catalog.** `MobSpec`'s `baseEscapeChance`/`actionsPerRound` are `bigint` on the TS
  side; the oracle's `JSON.stringify` uses a bigint→number replacer (mirroring `formation-descriptor.gen`).
- **Byte-parity is value-level.** The gate compares canonicalized `serde_json::Value`s, so a lore
  string written with `—` in the golden and the raw em-dash in the TOML compare equal; the exact
  `JOURNAL_LORE`/timeout narration are embedded verbatim (TOML multi-line literal / basic string).
- **Assemble validation drove two fixes discovered during implementation:** mob `drops` and formation
  opt-ins must reference registered items/formations (so the oracles register the brass/iron keys, the
  rat-tail item, and the rat formation behaviors); disconnected rooms are pruned by the TS assemble, so
  mob/formation rooms are connected to the start.

## Scope boundaries

- No `compile()` signature change; no ts-rs binding changes.
- Deferred (no Hollow House usage → bespoke-oracle-only): `endedNarration`, `chat`, `av`, `caches`,
  standalone `materials`/`recipes`, room `lights`, item `presentation`, mob
  inventorySlots/actionsPerRound/materialDrops/lightAverse overrides.
- **Next: the capstone** — the full Hollow House re-author (one TOML gated against the whole assembled
  campaign), now unblocked by this surface.
