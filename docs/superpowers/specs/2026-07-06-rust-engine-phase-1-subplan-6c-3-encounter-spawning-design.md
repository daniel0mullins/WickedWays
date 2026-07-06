# Rust Engine — Phase 1, Sub-plan 6c-3: Encounter Spawning (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core (`crates/wickedways-core`),
verified byte-for-byte against the TS "oracle" by a differential conformance gate. Sub-plan 6a built
the `MechanicOp` registry; 6c-1 ported keyed exits (`ExitBehavior`); 6c-2 ported scenes
(`SceneBehavior`) and extended the oracle so scene scripts emit cues. Sub-plan **6b
(`ScriptedMechanic`/Rhai) is DEFERRED**.

Sub-plan **6c-3** ports **encounter spawning** — the last registry-bound behavior the oracle has
(`FormationBehavior`) — using the same native-registry + matched-TS-shadow approach. Per the scope
decision, 6c-3 covers the **spawning feature + its integral `[PLACE]`-path scene firing + two
mob-related differential fixtures** (sees-in-dark visibility, mob-drop). Deferred to a later **6c-4**:
the `deposit_materials` fractional-quantity fix and the 6c-2 cleanup minors (see "Deferred").

Today the Rust core implements only the *visited-mark* half of `maybeSpawn` plus `NOTE_ENCOUNTERS`
(`movement.rs`); it does **not** spawn — there is no `FormationBehavior` trait, no `formation(key)`
registry, and no formation build/place code. The `encounter_table` is an opaque `serde_json::Value`
whose only read/written field is `visited`.

## The TS contract being ported (authoritative source)

`EncounterTable` (`src/lib/encounter-table.ts:38-47`): `#formations: Formation[]`,
`#visited: Set<string>`, `#rng`, `#baseChance`. `Formation` (`:17-24`) =
`{ id, weight, build: (campaign) => IMob[] }`. `addFormation` (`:57-69`) rejects `weight <= 0` and,
by minting one `build` sample, throws if any sampled mob holds a key (roving mobs may not drop keys).

`maybeSpawn(room, campaign): IMob[]` (`encounter-table.ts:82-102`):
1. If `#visited.has(room.id)` → return `[]`.
2. Else `#visited.add(room.id)` — the one chance is consumed **unconditionally**, even with zero formations.
3. If any occupant is a non-party, non-KO character → return `[]`.
4. If `#formations.length === 0` → return `[]`.
5. `threshold = clamp(#baseChance * room.spawnModifier, 0, 100)`; if `roll(100, #rng) > threshold` → return `[]`.
6. `mobs = #select().build(campaign)`; for each: `mob[SET_ORIGIN]("campaign")`; `mob[PLACE](room)`. Return `mobs`.

`#select()` (`:125-133`): weighted-random — `roll(sum(weights), #rng)`, walk subtracting weights.
`roll(sides, rng)` (`dice.ts`) = `floor(rng()*sides)+1`, one draw, integer `[1,sides]`.

**RNG draws per attempt:** 1 (threshold roll) on a miss; on a hit, `threshold-roll` then `select-roll`
then any draws inside `build` — always in that order. The conformance formation's `build` is rng-free,
so a hit is exactly 2 draws.

`PlayerCharacter.move` (`player-character.ts:169-176`):
```ts
override move(room: IRoom) {
  super.move(room);
  if (this.currentRoom === room) {
    this.campaign.maybeSpawn(room);
    this.campaign[NOTE_ENCOUNTERS](this, room);
    this.campaign[RECORD_ENCOUNTER]({ kind: "room", room }, this, room);
  }
}
```
`super.move` (`character.ts:1021-1038`) runs the affliction/budget gate → `#enterRoom` (fires exit/enter
scenes, emits their cues) → visibility cue → `recordAction` (budget tick, may `endTurn`→reconcile→turn-end
cues) **to completion first**. Then, only if the move landed: **`maybeSpawn` → `NOTE_ENCOUNTERS` → room
codex**. So spawned mobs are placed before the occupant scan, and spawn rng falls after any turn-end rng.

Placement: `mob[PLACE](room)` (`character.ts:980-983`) → `#enterRoom` fires the target room's enter-scenes
(exit-scenes only if the mob had a prior room; a fresh mob has none) and **discards their cues** (`[PLACE]`
is deliberately silent — no visibility cue, cues dropped). `maybeSpawn` itself emits no cues.

Serialization (`serializer.ts:63-90`): characters are collected from **party + every room's occupants**,
so a spawned mob placed into a room's occupants automatically appears in the snapshot.

Spawned-mob ids: `generateId` still returns a uuid (`util.ts:19-21`); the assembler overrides authored
ids deterministically (`mob:${name}`, `assembler.ts:230,237`), but a runtime `build` mob keeps its uuid
unless `build` assigns an explicit id. **So a reproducible spawn fixture requires the formation's `build`
to assign a deterministic id** on both the TS shadow and the Rust native impl.

## Design

### 1. `FormationBehavior` trait + registry — new `crates/wickedways-core/src/world/formations.rs`

Mirrors `scenes.rs`/`exits.rs`:
```rust
use crate::world::mechanics::CampaignView;
use crate::world::snapshot::CharacterSnapshot;
use alloc::vec::Vec;

pub trait FormationBehavior: Sync {
    /// TS `Formation.build(campaign)` — returns the mobs to spawn. Each must carry a
    /// DETERMINISTIC id (spawned ids are not auto-derived). v1 build is rng-free.
    fn build(&self, view: &CampaignView) -> Vec<CharacterSnapshot>;
}

/// Resolve a first-party formation by key. `None` for an unregistered key (surfaced as a
/// `ProceduralViolation` at the spawn site).
pub fn formation(key: &str) -> Option<&'static dyn FormationBehavior> { … }
```
Conformance impl behind `#[cfg(any(test, feature = "conformance"))]`: `conformance:wraith` builds **one
fixed mob** `CharacterSnapshot` with an explicit deterministic id (e.g. `"campaign-mob:wraith"`),
`kind = Mob`, `origin = None` (set to `"campaign"` by `maybe_spawn`), and the remaining fields modeled on
the mob shape the existing `mob-defeat` fixture already round-trips (low field-matching risk). `build`
takes `&CampaignView` for contract parity but the conformance formation ignores it and draws no rng.

### 2. `World::maybe_spawn` (in `formations.rs`)

Ports `maybeSpawn` exactly. Signature:
```rust
pub fn maybe_spawn(
    &mut self,
    room: &RoomId,
    cat: &Catalog,
) -> Result<Vec<CharacterId>, ProceduralViolation>
```
Logic, in order:
1. Read `encounter_table["visited"]` (array of room-id strings). If it contains `room` → return `Ok(vec![])`.
2. Push `room` onto `visited` (unconditional mark).
3. If any occupant of `room` is a non-party, non-KO character → return `Ok(vec![])` (uses `is_ko` + `party_ids`, mirroring the existing NOTE_ENCOUNTERS filters).
4. Read `encounter_table["formations"]` (array of `{behaviorKey, weight}`). If empty → return `Ok(vec![])`.
5. `base = encounter_table["baseChance"]` (i64); `spawn_mod = room.spawn_modifier` (i64, v1 — fractional `spawnModifier` deferred); `threshold = clamp(base * spawn_mod, 0, 100)`. `let r = roll(100, &mut self.rng)`; if `r > threshold` → return `Ok(vec![])` (**1 rng draw**).
6. Weighted select: `total = sum(weights)`; `pick = roll(total, &mut self.rng)` (**2nd rng draw**); walk the formations subtracting `weight` until `pick <= 0`, taking that `behaviorKey`.
7. `behavior = formation(&key).ok_or_else(|| ProceduralViolation(…"is not registered"))?`. `let view = self.build_campaign_view(cat)`. `let mobs = behavior.build(&view)`.
8. For each built mob snapshot: set `origin = Some("campaign")`; set `current_room_id = Some(room)`; insert into `self.characters`; push its id onto `room.occupant_ids` (guarding duplicates); then fire the room's **enter-scenes into a discarded cue buffer** (§4). Collect the ids.
9. Return `Ok(spawned_ids)`.

`roll` uses the existing `crate::world::dice::roll` (or equivalent) on the injected `self.rng`, matching TS `roll(sides, rng)` semantics exactly (`floor(rng()*sides)+1`).

### 3. `move_to` player-tail restructure (`movement.rs`)

Currently `move_to` computes the player-only tail (occupant scan / mob codex / encounter refs, the
`visited` mark, and the room codex) **before** `record_action`, emitting only the encounter *cues* after
it. Restructure so the entire player tail runs **after `record_action`**, matching `PlayerCharacter.move`:

```
… (base move: exit-scenes, occupant swap, enter-scenes, visibility cue, action cue) …
record_action(actor, true, "move", …)?;      // budget tick, may endTurn→reconcile→turn-end cues
if is_player {
    let spawned = self.maybe_spawn(&room, cat)?;          // roll/select/build/place (+ silent enter-scenes)
    // NOTE_ENCOUNTERS: scan room occupants (now incl. spawned), skip party/KO, dedup on
    //   "{actor}:{occ}" in campaign.encountered, record mob codex, stage encounter_refs
    // room codex (RECORD_ENCOUNTER {kind:"room"}), first-write-wins
    // emit encounter cues (after the move action cue and any turn-end cues)
}
```
The `visited` mark now lives inside `maybe_spawn` (step 2), not in `move_to`. Encounter cues are still
emitted last. Behavior for non-spawning moves is unchanged; existing mob-encounter fixtures/tests guard
the restructure. This also fixes the previously-noted latent ordering divergence (occupant scan must see
spawned mobs).

### 4. `[PLACE]`-path scene firing (silent)

`maybe_spawn` places each mob then fires the target room's enter-scenes with cues **discarded**, matching
TS `[PLACE]` dropping `#enterRoom`'s cues. Reuse the existing `fire_scenes` with a throwaway buffer:
```rust
let mut discard: Vec<PresentationCue> = Vec::new();
self.fire_scenes(room, "enter", cat, &mut discard)?; // silent: cues dropped, state still mutates
```
Only enter-scenes fire (a freshly built mob has no prior room, so no exit-scenes). An unregistered scene
`behavior_key` still surfaces as `Err` (propagated). The mob is an occupant before this fires (enter
timing).

### 5. Differential + mob fixtures

**Spawn fixture** (`spawn.gen.test.ts` + replay): a two-room map; a `conformance:wraith` formation
registered with `baseEncounterChance = 100` (so `threshold = clamp(100*1,0,100) = 100` and any `roll(100)`
∈ `[1,100]` is `<= 100` → **guaranteed, seed-independent spawn**); the destination room is fresh (unvisited,
no active occupant) and has an **enter-scene** (`conformance:visit-counter`) to prove silent scene firing on
spawn. Command stream: PC enters the destination room → spawn fires. The golden asserts, per step: the
spawned mob appears in `snapshot.characters` (byte-exact) and the room's `occupant_ids`; the `encounter`
cue + mob codex entry fire via NOTE_ENCOUNTERS; the room's enter-scene `state.count` incremented **with no
scene cue** (silent placement); and the rng stream lines up. Green-first-replay is the target; any field
divergence is fixed in the Rust `build`, never in the golden.

**Mob-drop fixture** (`mob-drop.gen.test.ts` + replay): a mob seeded with an **equipped item** and a **key**,
room-origin, defeated by the PC. Asserts the `${mob.id}:remains` loot box contains the item (still
`equipped: true` — no unequip, faithful to TS `mob.ts:198-206`) and the key; a second, **campaign-origin**
mob defeated in the same stream does **not** drop its key (`keys = origin === "room" ? [...] : []`).

**sees_in_dark fixture** (`sees-in-dark.gen.test.ts` + replay): a `light_averse` (seesInDark) mob attacks a
target in a **dark** room and succeeds — exercising the positive `requireVisibleTarget` path
(`character.ts:266-272`) differentially (complementing the existing lightAverse damage-amplification
coverage). The negative "Cannot attack in the dark" `ProceduralViolation` for a non-seeing actor stays
covered by Rust unit tests (a throwing command isn't representable in the golden step stream).

All three generators use the shared `structuralClone` (`gen-helpers.ts`) for captures.

### 6. Testing

- **Rust unit tests** (`formations.rs` / `movement.rs`): formation registry resolve/reject; `maybe_spawn`
  gating (already-visited → no spawn + visited still marked; active non-party occupant → no spawn; no
  formations → no spawn but visited marked; roll miss → no spawn (1 draw); roll hit → spawn (2 draws));
  weighted select picks by weight; spawned mob inserted into `characters` + `occupant_ids` with
  `origin="campaign"`; enter-scenes fire silently on spawn (scene state mutates, no cue); unregistered
  formation key → `ProceduralViolation`; restructured `move_to` preserves existing encounter cue/codex
  ordering for a non-spawning move into a mob room.
- **Differential fixtures:** the three above.
- **No unrelated golden churn:** existing fixtures have no formations → `maybe_spawn` marks visited and
  returns empty, unchanged behavior. `git status --short conformance/fixtures` shows only the new fixtures.
  Full gate `pnpm run checks:phase3` EXIT 0 + `pnpm run fixtures:stable` EXIT 0.
- **`no_std`:** `alloc::` only; conformance formation feature-gated, absent from `cargo build -p
  wickedways-core --no-default-features`.

## Deferred / carried (→ 6c-4)

- **`deposit_materials` fractional quantity** — Rust `as_i64().unwrap_or(0)` drops fractional `qty` to 0,
  diverging from TS (adds the float). Fix (`as_f64`) is gate-safe (the comparator parses to JS numbers, so
  integer `5.0`≡`5`) but needs a fractional-material-drop fixture to be covered. → 6c-4.
- **6c-2 cleanup minors** — restructure `scenes.rs::scene_behavior` to block-form `#[cfg]` (sibling-registry
  symmetry with `exits.rs`); extract the duplicated `viewProjected` into `gen-helpers.ts`; update concrete
  `Room.enterRoom/exitRoom` TSDoc. → 6c-4.
- **Formation-build rng** — v1 `build` is rng-free; a formation that randomizes mobs would need the injected
  rng threaded into `build`. Not needed by the conformance formation. → note.
- **Fractional `spawnModifier`** — modeled as `i64` in v1 (fixture uses `1`); a fractional multiplier would
  need a JS-number representation and float threshold comparison. → note.
- **`addFormation` weight/key validation** — TS validates `weight > 0` and roving-mob-holds-no-key at
  registration. Rust formations are compiled-in (no runtime registration), so this validation has no Rust
  analogue; the invariant is upheld by construction (the conformance formation holds no key). → note.

## Documentation

Per the standing convention, update `README.md` (and relevant Rust doc comments) to document encounter
spawning: the `FormationBehavior` registry, `maybe_spawn` (first-visit/occupant/roll gating, weighted
select, deterministic-id build, silent `[PLACE]` scene firing), and the `PlayerCharacter.move` ordering
(spawn → NOTE_ENCOUNTERS → room codex, after `record_action`) — before the work is considered done.
