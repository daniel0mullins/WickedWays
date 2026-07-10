# Rust Engine — Phase 1, Sub-plan 4c-2: Mob Defeat Drops — Design

**Status:** Approved (design), pending spec review
**Date:** 2026-07-02
**Parent:** Sub-plan 4c (mobs/encounters/escape/drops), split into 4c-1 (deterministic entity
ids — shipped) and **4c-2 (mob defeat drops — this doc)**. Builds on 4c-1's content-derived
ids (which make the runtime-minted loot box's id reproducible in the Rust replay).

## Goal

Make a mob a first-class defeatable occupant: when a player attacks a pre-placed mob to KO,
its `on_knock_out` deposits material drops (into the campaign material pool + codex) and drops
its inventory into a **`${mob.id}:remains`** loot box; and on room entry a player emits
encounter cues + mob codex records. Wire `sees_in_dark = light_averse`. All verified byte-for-
byte by the differential conformance gate. Encounter spawning, escape, and mob-AI turns remain
deferred to sub-plan 6.

## Architecture

A faithful port of the TS oracle's mob-defeat path. `reconcile` (from 4b) already fires
`on_knock_out` exactly once on the false→true KO edge; 4c-2 gives that hook a
`CharacterKind::Mob` branch (players stay a no-op). The branch mirrors `mob.ts:174-215`:
materials first (`DEPOSIT_MATERIALS` + per-material codex records), then the item/key drop
(relinquish → new `Loot` box → stash keys if room-origin → place in room). Encounter cues
port `campaign.ts` `NOTE_ENCOUNTERS`, fired from the player-move path. Codex writes reuse the
existing `move_to`/`take` append-with-dedup pattern; the material pool merge is a new helper
on `campaign.materials`.

The loot box is the first **runtime-minted** entity in the Rust replay. Its id is
**context-derived** `${mob.id}:remains` — computed identically in the TS oracle
(`Mob.onKnockOut` sets `box.id` after construction) and in the Rust `on_knock_out` — so the
minted box matches byte-for-byte with no counter or serialized id state (per 4c-1's scheme).

## Tech Stack

Rust `no_std` core (`alloc::`) + wasm; TS oracle (`src/`); serde, serde_json, ts-rs, vitest,
pnpm. Gate: `pnpm run checks:phase3` (`cargo build --no-default-features` + `cargo test
--workspace` + `bindings:check` + `test:conformance`).

## Global Constraints

- **The differential gate is the authority.** Divergences are fixed in Rust source, never by
  editing goldens or loosening `conformance/canonical-json.ts`.
- **Loot-box id is context-derived `${mob.id}:remains`** — identical string in TS
  (`Mob.onKnockOut`) and Rust (`on_knock_out`). No counter, no serialized id state. One box
  per mob (KO is edge-triggered once).
- **Byte-exact `on_knock_out` order** (mirrors `mob.ts:174-215`): materials deposit + material
  codex records FIRST, then item/key drop. Keys drop only if the mob's `origin == "room"`.
- **Codex dedup:** codex entries are first-write-wins per `${kind}::${key}` — material records
  keyed `material::${component}`, mob records `mob::${name}` — using the existing
  `move_to`/`take` append-with-dedup pattern. Codex order is significant (not sorted by the
  comparator): mob records (from `NOTE_ENCOUNTERS`) precede the room record on room entry.
- **`campaign.materials` merge is additive per component** (`existing + qty`), mirroring
  `DEPOSIT_MATERIALS` (`campaign.ts:580-587`).
- **`on_knock_out` remains edge-triggered once** — an already-KO'd mob reconciling again drops
  nothing further.
- **`no_std` core** — verified by BUILD only; unit tests run under DEFAULT features.
- **Randomness:** the mob-defeat path draws no rng (materials/codex/drop/encounter-cues are
  rng-free); the only combat rng is 4a's Confused fizzle in `gate`.
- **Deferred to sub-plan 6:** encounter spawning (`maybeSpawn`/formations), escape, mob-AI
  turns, and the differential coverage of `sees_in_dark` (mobs don't act in Phase 1).

## 1. `sees_in_dark` wiring (`view.rs`)

Replace the `false` stub (mirrors `mob.ts:101-104`, `seesInDark === lightAverse`):

```rust
pub fn sees_in_dark(&self, actor: &CharacterId) -> bool {
    self.characters.get(actor).and_then(|c| c.light_averse).unwrap_or(false)
}
```

Read at `require_visible_target` (combat) and `take` (looting) — both actor-driven. Since
mobs don't act in Phase 1, this has **no differential-gate-observable effect in 4c-2**; it is
covered by a **Rust unit test** (`sees_in_dark(light_averse mob) == true`,
`sees_in_dark(plain PC) == false`). Differential coverage lands in sub-plan 6 (mob turns).

## 2. `campaign.materials` deposit (Rust helper) + material codex records

**`DEPOSIT_MATERIALS`** — additive merge of a `MaterialMap` into `campaign.materials` (a
`serde_json::Value` object): for each `(component, qty)` in the mob's `material_drops`,
`materials[component] = (materials[component] ?? 0) + qty`. Generic over whatever component
keys are present. Port of `campaign.ts:580-587`.

**Material codex records** — for each deposited component, append a codex entry (deduped
`material::${component}`, first-write-wins), shape (port of `codex.ts` `buildEntry`):

```json
{ "kind": "material", "key": "<component>",
  "snapshot": { "type": "<component>" },
  "firstSeen": { "round": <n>, "characterId": "<attacker id>", "roomId": "<mob room id>" } }
```

`firstSeen.characterId` = the active character (the attacker, `world.active_character_id()`);
`roomId` = the mob's `current_room_id`. Reuse the `move_to`/`take` codex append+dedup pattern.

## 3. `on_knock_out` Mob branch (byte-exact port of `mob.ts:174-215`)

In `combat.rs`, `on_knock_out(actor, cat, cues)` branches on `CharacterKind::Mob` (players →
no-op, as today). Exact ordered sequence:

1. **Materials** (only if `material_drops` non-empty): `DEPOSIT_MATERIALS` (§2), then the
   per-component material codex records (§2). `by` = active character; captured before mutation.
2. **Item/key drop** — early-return if the mob has no room. Collect the mob's inventory items;
   collect keys **only if `origin == "room"`**. If both empty, return. Then:
   - Relinquish each item from the mob's inventory.
   - Create a `Loot` box: `id = ${mob.id}:remains`, `description = "${mob.name}'s remains"`,
     `capacity = contents.length + 2`, contents = the relinquished items.
   - For each key: relinquish + stash into the box (bypassing the key-rejection guard, port
     of `[STASH_DROP]`).
   - Insert the box into `world.loot` and append its id to the room's `loot_ids`.

**TS side:** `Mob.onKnockOut` (`mob.ts:207`) changes from `new Loot({…})` (uuid) to setting
`box.id = ${this.id}:remains` post-construction (mutable `id`, per 4c-1), so the oracle golden
carries the context-derived id.

The dropped items already have content-derived genesis ids (`mob:<name>:drop#<i>` from 4c-1);
only the box is newly minted, and its id derives from `mob.id`.

## 4. `NOTE_ENCOUNTERS` on player room entry (`move_to`)

Port of `campaign.ts:777-792`, fired when a **player** enters a room (in `move_to`, after the
move action cue). For each occupant that is **non-party and non-KO**, deduped per
`${charId}:${occupantId}` in `campaign.encountered` (append the key on first sight):
- Emit `PresentationCue::Encounter { mob: {id,name}, room: {id,name}, sound: mob.presentation?.sound }`.
- Append a mob codex record (deduped `mob::${name}`):
  `{ "kind":"mob", "key":<name>, "snapshot":{ "name", "stats":{health,sanity,energy}, "presentation"? }, "firstSeen":{round, characterId:<mover>, roomId} }`.

**Order** (matches TS `PlayerCharacter.move`): the move action cue (from the existing
`move_to`) → encounter cues; and in the codex, the mob records (from `NOTE_ENCOUNTERS`)
precede the existing room `RECORD_ENCOUNTER` record. Insert the `NOTE_ENCOUNTERS` logic before
the room-codex append in `move_to`.

## 5. KO re-fire-suppression test

Now that `on_knock_out` has observable effects, add the test 4b's review deferred: reconciling
an **already-KO'd** mob does not drop a second box, re-deposit materials, or re-record codex
entries. (Unit test in `combat.rs`: KO a mob with drops, capture the world, reconcile again,
assert `world.loot` count / `campaign.materials` unchanged.)

## 6. Conformance fixture (`mob-defeat.gen.test.ts`) + differential gate

**Campaign:** two connected lit rooms. The player **starts adjacent** to a room holding a
pre-placed **mob** (room-origin) carrying `material_drops` (e.g. `{metal:2, bone:1}`), an
inventory item or two, and optionally a key; the player is equipped with a weapon.
`baseEncounterChance:0` (no spawning). Single shared `mulberry32(SEED)` into the PC + campaign
(the mob is authored via the assembler / manual construction, mirroring the 4b/afflictions
fixtures). The player starts adjacent (not in the mob's room) so that a `Go` command triggers
`NOTE_ENCOUNTERS` on entry — encounter cues fire on room *entry via move*, not on genesis
placement.

**Command stream** exercises, in order:
1. Player **moves** (`Go`) into the mob's room → **encounter cue** + mob codex record fire on
   entry.
2. Player **attacks** the mob (reusing 4b combat) until KO.
3. On KO, `on_knock_out` → **materials deposited** (`campaign.materials` grows) + **material
   codex records** + **`${mob.id}:remains` loot box** dropped (items moved, key stashed if
   room-origin) into `world.loot` + `room.loot_ids`; mob shows **`defeated:true`** in the view.
4. Player **takes** an item from the remains (reusing 3b looting).

The golden captures all of: encounter cue, mob + material codex records (correct order),
`campaign.materials` merge, the deterministically-id'd dropped box + its contents, the
`defeated` flag, and the successful loot. `mob-defeat.test.ts` is the per-step
`canonicalize`+`toEqual` differential gate (cues+snapshot+view+step count), mirroring
`combat.test.ts`. Isolation: only the four `mob-defeat.*` files + the vitest config change.

## 7. File structure

**Rust core (modify):**
- `crates/wickedways-core/src/world/view.rs` — `sees_in_dark` reads `light_averse`.
- `crates/wickedways-core/src/world/combat.rs` — `on_knock_out` Mob branch (materials + drop);
  the `Loot`-box creation + `${mob.id}:remains` id + `set_durability`-style seams.
- `crates/wickedways-core/src/world/` — a `campaign.materials` merge helper + material/mob
  codex append (reusing the `move_to`/`take` dedup pattern); likely a small `codex`/`materials`
  helper module or inline in `combat.rs`/`movement.rs`.
- `crates/wickedways-core/src/world/movement.rs` — `NOTE_ENCOUNTERS` (encounter cues + mob
  codex) on player room entry, before the room-codex append.

**TS oracle (modify):**
- `src/lib/character/mob.ts:207` — set `box.id = ${this.id}:remains` (context-derived).

**Conformance (create):**
- `conformance/fixtures/mob-defeat.gen.test.ts`, `conformance/mob-defeat.test.ts`, + the three
  `mob-defeat.*.json` fixtures; register the generator in `conformance/fixtures/vitest.config.ts`.

**Docs:** update `README.md`'s mob / loot section (defeat drops, `${mob.id}:remains`, encounter
cues, `sees_in_dark`).

## 8. Task decomposition shape (~6 tasks)

1. **`sees_in_dark` = `light_averse`** (view.rs) + unit test.
2. **`campaign.materials` deposit helper + material codex records** (with dedup) + unit tests.
3. **`on_knock_out` Mob branch: item/key loot-box drop** (`${mob.id}:remains`, stash keys if
   room-origin, place in room) wiring the §2 materials path + the KO re-fire-suppression test;
   TS `mob.ts:207` box-id change.
4. **`NOTE_ENCOUNTERS`** in `move_to` (encounter cues + mob codex, dedup, correct order) + unit
   test.
5. **`mob-defeat.gen.test.ts`** fixture (pre-placed mob, attack→defeat→loot) + goldens.
6. **`mob-defeat.test.ts`** differential gate + `checks:phase3` green + README.

## Out of scope (sub-plan 6)

- **Encounter spawning** (`maybeSpawn`, formations, the `behaviorKey→build` registry).
- **Escape** (mob action, needs mob turns).
- **Mob-AI turns** (mobs attacking players; and the differential coverage of `sees_in_dark`).
- **`npc_behavior_key` / dialogue mechanics.**
