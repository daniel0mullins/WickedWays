# Rust Campaign Author (G2) — Description-structure surface Plan

**Goal:** Close the `CampaignDescription` structure gap so the author can emit every field the real
Hollow House needs, in eight slices each gated byte-for-byte against a bespoke `g2-*` oracle that
authors the real content.

**Spec:** `docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md`.

## Global constraints

- Byte-parity is the authority; regenerate via the TS generator, never hand-edit goldens.
- Panic-free on author input; `BTreeMap` only.
- Never clobber an existing oracle — each slice adds a NEW fixture.
- `compile()`'s signature and the ts-rs bindings are unchanged.

## Slices (all complete)

1. **Archetypes** — `author_doc::ArchetypeEntry` + `AuthorDoc.archetypes`; map to `ArchetypeDef`.
   Oracle `g2-archetype` (real Heir, PC seated as it).
2. **Full item descriptor** — extend `ItemEntry` + `lower_item` (equippable/droppable/slot/twoHanded/
   emitsLight/maxDurability/lore). Oracle `g2-equipment` (lantern/poker/journal; exact JOURNAL_LORE
   embedded via a generated TOML).
3. **Placed mobs** — `MobEntry` + `AuthorDoc.mobs`; map to `MobDef`. Oracle `g2-mobs` (Wraith/Revenant;
   register the brass/iron key drop items).
4. **Room dark + spawnModifier** — extend `RoomEntry` + the room lowering. Oracle `g2-dark-rooms`.
5. **Exit name + initialState** — extend `ExitEntry` + the exit lowering. Oracle `g2-exit-state`.
6. **Formations** — `FormationEntry` (key/weight/mobs) → `FormationDef` (description) +
   `FormationDescriptor` (catalog); `mobs: Vec<MobSpec>` deserializes directly. Oracle `g2-formations`
   (register the rat formations + rat-tail; bigint→number replacer in the generator).
7. **Campaign opts** — `AuthorDoc.opts: CampaignOpts` deserialized directly. Oracle `g2-opts`.
8. **Timeout narration** — `AuthorDoc.timeout_narration: Option<String>` → `{ text }`. Oracle `g2-timeout`.

Each slice: gate.rs description/catalog/determinism + goldens.rs genesis golden.

## Finalize

- README: document the completed description surface; extend the gate list; update forward-pointers.
- Run `cargo test --workspace`, `pnpm run bindings:check`, `pnpm run fixtures:stable`, `pnpm checks`.

## Notes / gotchas discovered

- Assemble validates mob drops + formation opt-ins against the registry — register the referenced
  items/formations in each oracle.
- Disconnected rooms are pruned by the TS assemble — connect mob/formation rooms to the start.
- Win/lose conditions and mechanic `actions` serialize in sorted key order (from the prior batch);
  formations/mobs preserve declaration order.
- `MobSpec` bigints (baseEscapeChance/actionsPerRound) need a JSON bigint→number replacer.

## Next

The full Hollow House re-author (one TOML gated against the whole assembled campaign) — now unblocked.
