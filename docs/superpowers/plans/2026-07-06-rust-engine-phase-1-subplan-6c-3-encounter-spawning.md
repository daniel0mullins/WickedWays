# Sub-plan 6c-3: Encounter Spawning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port TS encounter spawning to the Rust core — a `FormationBehavior` registry, `World::maybe_spawn`, and a `move_to` restructure so a player entering a fresh room can spawn mobs — verified by differential fixtures, plus two carried mob fixtures.

**Architecture:** Mirror the `scenes.rs`/`exits.rs` native-registry + matched-TS-shadow pattern: a `FormationBehavior` trait resolved by `behavior_key`, a conformance formation that builds a fixed mob with a deterministic id. `maybe_spawn` ports `EncounterTable.maybeSpawn` (visited/occupant/roll gating, weighted select, build, silent `[PLACE]` scene firing). The player-only move tail (spawn → NOTE_ENCOUNTERS → room codex) is moved to run after `record_action`, matching `PlayerCharacter.move`.

**Tech Stack:** Rust `no_std` core (`crates/wickedways-core`) → WASM; TypeScript oracle (`src/lib/`); vitest differential harness (`conformance/`).

## Global Constraints

- **The differential conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens or loosening `conformance/canonical-json.ts`.
- **`no_std` core:** `alloc::` only, never `std::`. All conformance behaviors behind `#[cfg(any(test, feature = "conformance"))]`, absent from the default build (`cargo build -p wickedways-core --no-default-features` succeeds).
- **RNG:** all randomness via the injected `self.rng` (`World.rng: Rng`); dice via `crate::dice::roll(sides: u32, unit: f64) -> u32` with `self.rng.next_f64()`. A spawn attempt draws exactly 1 (threshold roll) on a miss, and 2 (threshold roll then weighted-select roll) on a hit — the conformance `build` is rng-free.
- **Spawn ordering (load-bearing):** the player-move tail runs AFTER `record_action` in this order: `maybe_spawn` → NOTE_ENCOUNTERS (scan occupants incl. spawned, mob codex + encounter cues) → room codex. Encounter cues emit last (after the move action cue and any turn-end cues).
- **`maybe_spawn` emits NO cues.** Placement fires the target room's enter-scenes into a DISCARDED buffer (silent `[PLACE]`), matching TS. Scene state still mutates.
- **Deterministic spawned-mob ids:** the conformance formation's `build` (both Rust and the TS shadow) assigns an explicit deterministic id (`"campaign-mob:wraith"`) — spawned ids are not auto-derived.
- **Spawned mob visibility:** insert each spawned mob into BOTH `self.characters` and the room's `occupant_ids`; set `origin = Some(json!("campaign"))`.
- **Illegal ops throw `ProceduralViolation`:** an unregistered formation `behavior_key` at spawn → `Err(ProceduralViolation)`.
- **No unrelated golden churn:** existing fixtures have no formations, so `maybe_spawn` marks visited and returns empty — behavior unchanged. `git status --short conformance/fixtures` shows only the new fixtures.
- **Full gate:** `pnpm run checks:phase3` EXIT 0 and `pnpm run fixtures:stable` EXIT 0.
- **Docs:** update `README.md` + Rust doc comments to document spawning before done.

---

## File Structure

- `crates/wickedways-core/src/world/formations.rs` — NEW: `FormationBehavior` trait, `formation(key)` registry, `conformance::Wraith`, and `World::maybe_spawn`.
- `crates/wickedways-core/src/world/mod.rs` — register `pub mod formations;`.
- `crates/wickedways-core/src/world/movement.rs` — restructure `move_to`'s player tail to run after `record_action` and call `maybe_spawn`.
- `conformance/fixtures/formation-shadow.ts` — NEW: TS `FormationBehavior` shadow of `conformance:wraith`.
- `conformance/fixtures/spawn.gen.test.ts` + `conformance/spawn.test.ts` — NEW: spawn differential fixture.
- `conformance/fixtures/mob-drop.gen.test.ts` + `conformance/mob-drop.test.ts` — NEW: mob drop-on-defeat fixture.
- `conformance/fixtures/sees-in-dark.gen.test.ts` + `conformance/sees-in-dark.test.ts` — NEW: dark-visibility fixture.
- `conformance/fixtures/vitest.config.ts` — add the three new generators to the include allowlist.
- `README.md` — document encounter spawning.

---

## Task 1: `FormationBehavior` trait + registry + conformance formation

**Files:**
- Create: `crates/wickedways-core/src/world/formations.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (add `pub mod formations;` next to `pub mod scenes;`)

**Interfaces:**
- Consumes: `CampaignView` (`crate::world::mechanics`), `CharacterSnapshot`/`Stats`/`InventorySnapshot`/`CharacterKind` (`crate::world::snapshot`), `Afflictions` (`crate::world::afflictions`).
- Produces:
  - `pub trait FormationBehavior: Sync { fn build(&self, view: &CampaignView) -> Vec<CharacterSnapshot>; }`
  - `pub fn formation(key: &str) -> Option<&'static dyn FormationBehavior>`
  - `conformance::WRAITH` under key `"conformance:wraith"`; a free helper `build_wraith() -> CharacterSnapshot` (deterministic, testable without a view).

- [ ] **Step 1: Write the module with tests**

Create `crates/wickedways-core/src/world/formations.rs`:

```rust
//! Encounter formations: a native `FormationBehavior` trait resolved by
//! `behavior_key` (mirrors `mechanic_op`/`exit_behavior`/`scene_behavior`), plus
//! `World::maybe_spawn` (the port of TS `EncounterTable.maybeSpawn`). Behavior is
//! compiled-in; only the encounter table's `visited`/`formations`/`baseChance`
//! serialize.
use alloc::vec::Vec;

use crate::world::mechanics::CampaignView;
use crate::world::snapshot::CharacterSnapshot;

/// A first-party encounter formation. `build` returns the mobs to spawn; each MUST
/// carry a deterministic id (spawned ids are not auto-derived). v1 `build` is rng-free.
pub trait FormationBehavior: Sync {
    fn build(&self, view: &CampaignView) -> Vec<CharacterSnapshot>;
}

/// Resolve a first-party formation by key. `None` for an unregistered key (surfaced
/// as a `ProceduralViolation` at the spawn site).
pub fn formation(key: &str) -> Option<&'static dyn FormationBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:wraith" {
        return Some(&conformance::WRAITH);
    }
    let _ = key;
    None
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use alloc::collections::BTreeMap;
    use crate::world::afflictions::Afflictions;
    use crate::world::ids::CharacterId;
    use crate::world::snapshot::{CharacterKind, InventorySnapshot, Stats};

    /// The deterministic id of the spawned wraith (assigned in `build`, matched by
    /// the TS shadow). Spawned ids are not auto-derived.
    pub const WRAITH_ID: &str = "campaign-mob:wraith";

    /// Build the fixed conformance mob. `origin`/`current_room_id` are left `None`
    /// here — `World::maybe_spawn` sets `origin = "campaign"` and the room. Modeled
    /// on the mob shape the `mob-defeat` fixture round-trips.
    pub fn build_wraith() -> CharacterSnapshot {
        CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: CharacterId(WRAITH_ID.into()),
            name: "Wraith".into(),
            stats: Stats { health: 4.0, sanity: 0.0, energy: 3.0 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: None,
            inventory: InventorySnapshot { slots: 0, item_ids: Vec::new(), key_ids: Vec::new() },
            equipment: BTreeMap::new(),
            history: Vec::new(),
            archetype_immunities: Vec::new(),
            afflictions: Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        }
    }

    pub struct Wraith;
    pub static WRAITH: Wraith = Wraith;

    impl FormationBehavior for Wraith {
        fn build(&self, _view: &CampaignView) -> Vec<CharacterSnapshot> {
            alloc::vec![build_wraith()]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_wraith_and_rejects_unknown() {
        assert!(formation("conformance:wraith").is_some());
        assert!(formation("nope").is_none());
    }

    #[test]
    fn build_wraith_is_deterministic_mob() {
        let m = conformance::build_wraith();
        assert_eq!(m.id.0, "campaign-mob:wraith");
        assert_eq!(m.name, "Wraith");
        assert!(matches!(m.kind, crate::world::snapshot::CharacterKind::Mob));
        assert_eq!(m.origin, None); // maybe_spawn sets origin
        assert_eq!(m.current_room_id, None); // maybe_spawn sets the room
    }
}
```

> Confirm every `CharacterSnapshot` field name/type against `snapshot.rs` (and the `seat_mob` helper in `movement.rs` tests, which constructs the same shape). If any field differs, match the real definition — do not invent fields.

- [ ] **Step 2: Register the module, run the tests**

Add `pub mod formations;` to `crates/wickedways-core/src/world/mod.rs` next to `pub mod scenes;`.

Run: `cargo test -p wickedways-core formations::`
Expected: PASS (2 tests). If a `CharacterSnapshot` field is wrong, fix to match `snapshot.rs` and re-run.

- [ ] **Step 3: Verify `no_std`**

Run: `cargo build -p wickedways-core --no-default-features`
Expected: SUCCESS (conformance module compiled out).

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-core/src/world/formations.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): FormationBehavior trait + registry + conformance:wraith (6c-3)"
```

---

## Task 2: `World::maybe_spawn`

**Files:**
- Modify: `crates/wickedways-core/src/world/formations.rs` (add `impl World { fn maybe_spawn }` + tests)

**Interfaces:**
- Consumes: `formation(key)` (Task 1), `crate::dice::roll`, `self.rng.next_f64()`, `self.build_campaign_view(cat)`, `self.fire_scenes(room, "enter", cat, &mut discard)` (from 6c-2), `self.is_ko(id)`.
- Produces: `pub fn maybe_spawn(&mut self, room: &RoomId, cat: &Catalog) -> Result<Vec<CharacterId>, ProceduralViolation>` (emits no cues; fires enter-scenes silently; marks visited; inserts spawned mobs into `characters` + `occupant_ids`).

- [ ] **Step 1: Write the failing tests**

Add a `tests` block (or extend the existing one) in `formations.rs`. These build a world with a registered formation in the encounter table. Add a helper to register the conformance formation + set baseChance:

```rust
#[cfg(test)]
mod spawn_tests {
    use super::*;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::world_two_rooms;

    fn rid(s: &str) -> RoomId { RoomId(s.into()) }

    /// Put a single `conformance:wraith` formation (weight 1) and a baseChance into
    /// the encounter table, and clear `visited`.
    fn arm_encounter_table(w: &mut crate::world::World, base_chance: i64) {
        w.campaign.encounter_table = serde_json::json!({
            "baseChance": base_chance,
            "visited": [],
            "formations": [ { "behaviorKey": "conformance:wraith", "weight": 1 } ]
        });
    }

    #[test]
    fn spawns_wraith_when_threshold_guarantees_and_marks_visited() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 100); // threshold = clamp(100*spawn_mod,0,100) = 100 → always
        // ensure spawn_modifier is 1 on "next"
        if let Some(r) = w.rooms.get_mut(&rid("next")) { r.spawn_modifier = 1; }
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert_eq!(spawned, alloc::vec![CharacterId("campaign-mob:wraith".into())]);
        // inserted into characters with origin "campaign" and room "next"
        let m = &w.characters[&CharacterId("campaign-mob:wraith".into())];
        assert_eq!(m.origin, Some(serde_json::json!("campaign")));
        assert_eq!(m.current_room_id, Some(rid("next")));
        // present in the room occupants
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&CharacterId("campaign-mob:wraith".into())));
        // visited marked
        assert!(w.campaign.encounter_table["visited"].as_array().unwrap()
            .iter().any(|v| v == "next"));
    }

    #[test]
    fn no_spawn_when_already_visited_but_still_returns_empty() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 100);
        if let Some(arr) = w.campaign.encounter_table["visited"].as_array_mut() {
            arr.push(serde_json::json!("next"));
        }
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(!w.characters.contains_key(&CharacterId("campaign-mob:wraith".into())));
    }

    #[test]
    fn no_spawn_when_active_non_party_occupant_present_but_marks_visited() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 100);
        // seat a live mob in "next"
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.occupant_ids.push(CharacterId("resident".into()));
        }
        // (insert a minimal live mob "resident" so is_ko(false); reuse seat helper pattern)
        crate::world::formations::conformance::seat_test_mob(&mut w, "resident", "next");
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(w.campaign.encounter_table["visited"].as_array().unwrap().iter().any(|v| v == "next"));
    }

    #[test]
    fn no_spawn_when_no_formations_but_marks_visited() {
        let mut w = world_two_rooms(false);
        w.campaign.encounter_table = serde_json::json!({ "baseChance": 100, "visited": [], "formations": [] });
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(w.campaign.encounter_table["visited"].as_array().unwrap().iter().any(|v| v == "next"));
    }

    #[test]
    fn roll_miss_does_not_spawn() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 0); // threshold 0 → roll(100) always > 0 → never spawn
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(!w.characters.contains_key(&CharacterId("campaign-mob:wraith".into())));
    }
}
```

> If a `seat_test_mob` helper does not already exist, add a small one in the `conformance` module of `formations.rs` (mirroring `seat_mob` in `movement.rs` tests) OR inline the mob insert in the test. The point is a live (non-KO) non-party occupant.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p wickedways-core -- maybe_spawn spawns_wraith no_spawn roll_miss`
Expected: FAIL — `maybe_spawn` does not exist.

- [ ] **Step 3: Implement `maybe_spawn`**

Add to `formations.rs`:

```rust
use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, RoomId};
use crate::world::World;

impl World {
    /// Port of TS `EncounterTable.maybeSpawn` (`encounter-table.ts:82-102`). Marks
    /// the room visited (once), then — if unvisited, no active non-party occupant,
    /// formations present, and the threshold roll passes — selects one weighted
    /// formation, builds its mobs, and places each (origin "campaign", inserted into
    /// `characters` + `occupant_ids`, room enter-scenes fired SILENTLY). Emits no
    /// cues. Returns the spawned ids.
    pub fn maybe_spawn(
        &mut self,
        room: &RoomId,
        cat: &Catalog,
    ) -> Result<Vec<CharacterId>, ProceduralViolation> {
        // 1-2. first-visit-only; mark visited unconditionally.
        let already = self
            .campaign
            .encounter_table
            .get("visited")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().any(|v| v.as_str() == Some(&room.0)))
            .unwrap_or(false);
        if already {
            return Ok(Vec::new());
        }
        if let Some(arr) = self.campaign.encounter_table.get_mut("visited").and_then(|v| v.as_array_mut()) {
            arr.push(serde_json::Value::String(room.0.clone()));
        }

        // 3. suppressed if any active (non-KO) non-party occupant present.
        let party: alloc::collections::BTreeSet<CharacterId> =
            self.campaign.party_ids.iter().cloned().collect();
        let occupants: Vec<CharacterId> =
            self.rooms.get(room).map(|r| r.occupant_ids.clone()).unwrap_or_default();
        if occupants.iter().any(|o| !party.contains(o) && !self.is_ko(o)) {
            return Ok(Vec::new());
        }

        // 4. no formations → no spawn.
        let formations: Vec<(alloc::string::String, i64)> = self
            .campaign
            .encounter_table
            .get("formations")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| {
                        let k = f.get("behaviorKey")?.as_str()?.to_string();
                        let w = f.get("weight")?.as_i64()?;
                        Some((k, w))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if formations.is_empty() {
            return Ok(Vec::new());
        }

        // 5. threshold roll (1 rng draw). threshold = clamp(baseChance * spawnModifier, 0, 100).
        let base = self.campaign.encounter_table.get("baseChance").and_then(|v| v.as_i64()).unwrap_or(0);
        let spawn_mod = self.rooms.get(room).map(|r| r.spawn_modifier).unwrap_or(1);
        let threshold = (base * spawn_mod).clamp(0, 100);
        let r = crate::dice::roll(100, self.rng.next_f64()) as i64;
        if r > threshold {
            return Ok(Vec::new());
        }

        // 6. weighted select (2nd rng draw).
        let total: i64 = formations.iter().map(|(_, w)| *w).sum();
        let mut pick = crate::dice::roll(total as u32, self.rng.next_f64()) as i64;
        let mut chosen: Option<&str> = None;
        for (k, w) in &formations {
            pick -= *w;
            if pick <= 0 {
                chosen = Some(k);
                break;
            }
        }
        let key = chosen.unwrap_or(&formations[formations.len() - 1].0);
        let behavior = formation(key)
            .ok_or_else(|| ProceduralViolation(alloc::format!("Formation '{key}' is not registered.")))?;

        // 7. build.
        let view = self.build_campaign_view(cat);
        let mobs = behavior.build(&view);

        // 8. place each: origin "campaign", room set, insert, occupant push, silent enter-scenes.
        let mut spawned = Vec::new();
        for mut mob in mobs {
            mob.origin = Some(serde_json::json!("campaign"));
            mob.current_room_id = Some(room.clone());
            let id = mob.id.clone();
            self.characters.insert(id.clone(), mob);
            if let Some(r) = self.rooms.get_mut(room) {
                if !r.occupant_ids.contains(&id) {
                    r.occupant_ids.push(id.clone());
                }
            }
            // Silent [PLACE] enter-scene firing: cues discarded.
            let mut discard: Vec<PresentationCue> = Vec::new();
            self.fire_scenes(room, "enter", cat, &mut discard)?;
            spawned.push(id);
        }
        Ok(spawned)
    }
}
```

> `fire_scenes` may be `pub(crate)` or private in `movement.rs`; if it is not visible from `formations.rs`, widen its visibility to `pub(crate)`. `spawn_modifier` is `i64` on `RoomSnapshot` (v1; fractional deferred).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p wickedways-core -- maybe_spawn spawns_wraith no_spawn roll_miss`
Expected: PASS.

- [ ] **Step 5: Full crate tests + `no_std`**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS + SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/formations.rs
git commit -m "feat(core): World::maybe_spawn (roll/select/build/place, silent scenes) (6c-3)"
```

---

## Task 3: `move_to` player-tail restructure

**Files:**
- Modify: `crates/wickedways-core/src/world/movement.rs` (`move_to` ~:246-363)

**Interfaces:**
- Consumes: `World::maybe_spawn` (Task 2).
- Produces: no new public API — the player-only tail (spawn → NOTE_ENCOUNTERS → room codex) now runs AFTER `record_action`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `movement.rs`. This asserts a player move into a fresh room with an armed encounter table spawns a mob, and the mob gets an encounter cue after the move action cue:

```rust
#[test]
fn player_move_into_fresh_room_spawns_and_encounters() {
    use crate::world::ids::CharacterId;
    let mut w = world_two_rooms(false);
    // arm the encounter table with a guaranteed spawn
    w.campaign.encounter_table = serde_json::json!({
        "baseChance": 100, "visited": [],
        "formations": [ { "behaviorKey": "conformance:wraith", "weight": 1 } ]
    });
    if let Some(r) = w.rooms.get_mut(&rid("next")) { r.spawn_modifier = 1; }
    let mut cues = Vec::new();
    w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();

    // wraith spawned into "next"
    let wid = CharacterId("campaign-mob:wraith".into());
    assert_eq!(w.characters[&wid].current_room_id, Some(rid("next")));
    assert!(w.rooms[&rid("next")].occupant_ids.contains(&wid));

    // encounter cue for the wraith comes AFTER the move action cue
    let mv = cues.iter().position(|c| matches!(c, PresentationCue::Action { action: ActionKind::Move, .. })).unwrap();
    let enc = cues.iter().position(|c| matches!(c, PresentationCue::Encounter { mob, .. } if mob.id == "campaign-mob:wraith")).unwrap();
    assert!(enc > mv, "spawned-mob encounter cue comes after the move action cue");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p wickedways-core player_move_into_fresh_room_spawns_and_encounters`
Expected: FAIL — `move_to` currently only marks visited; it never spawns.

- [ ] **Step 3: Restructure the `move_to` player tail**

In `movement.rs`, the player-only block currently runs the NOTE_ENCOUNTERS scan (~:259-281), the visited-mark + room codex (~:283-329) BEFORE `record_action` (~:357), emitting only encounter cues after (~:360-362). Restructure so the ENTIRE player tail runs AFTER `record_action`, calling `maybe_spawn` first. Replace the two `if is_player { … }` blocks (the scan block and the visited/codex block) — delete them from their current position — and, after the `self.record_action(actor, true, "move", cat, cues)?;` line, insert:

```rust
        self.record_action(actor, true, "move", cat, cues)?;

        // PlayerCharacter.move tail (player-character.ts:169-176), AFTER super.move's
        // recordAction: maybeSpawn → NOTE_ENCOUNTERS → room codex. Spawned mobs land
        // before the occupant scan; spawn rng falls after any turn-end rng.
        if is_player {
            // maybeSpawn: roll/select/build/place (marks visited; fires enter-scenes silently).
            self.maybe_spawn(&room, cat)?;

            // NOTE_ENCOUNTERS: scan occupants (now incl. spawned), skip party/KO, dedup on
            // "{actor}:{occ}" in campaign.encountered; record mob codex; stage encounter cues.
            let party: BTreeSet<CharacterId> = self.campaign.party_ids.iter().cloned().collect();
            let occupants: Vec<CharacterId> =
                self.rooms.get(&room).map(|r| r.occupant_ids.clone()).unwrap_or_default();
            let mut encounter_refs: Vec<EntityRef> = Vec::new();
            for occ in occupants {
                if party.contains(&occ) { continue; }
                if self.is_ko(&occ) { continue; }
                let key = format!("{}:{}", actor.0, occ.0);
                if self.campaign.encountered.iter().any(|k| k == &key) { continue; }
                self.campaign.encountered.push(key);
                let (name, stats) = self.characters.get(&occ)
                    .map(|c| (c.name.clone(), (c.stats.health, c.stats.sanity, c.stats.energy)))
                    .unwrap_or_default();
                self.record_codex(
                    "mob", &name,
                    serde_json::json!({ "name": name, "stats": { "health": stats.0, "sanity": stats.1, "energy": stats.2 } }),
                    Some(&actor.0), Some(&room.0),
                );
                encounter_refs.push(self.entity_ref_char(&occ));
            }

            // RECORD_ENCOUNTER({kind:"room"}): first-write-wins room codex entry.
            let room_id_str = room.0.clone();
            let already_in_codex = self.codex.as_array()
                .map(|arr| arr.iter().any(|e|
                    e.get("kind").and_then(|v| v.as_str()) == Some("room")
                    && e.get("key").and_then(|v| v.as_str()) == Some(&room_id_str)))
                .unwrap_or(false);
            if !already_in_codex {
                let (room_name_str, room_desc) = self.rooms.get(&room)
                    .map(|r| (r.name.clone(), r.description.clone())).unwrap_or_default();
                let entry = serde_json::json!({
                    "kind": "room", "key": room_id_str,
                    "snapshot": { "name": room_name_str, "description": room_desc },
                    "firstSeen": { "round": self.campaign.round, "characterId": actor.0.clone(), "roomId": room_id_str }
                });
                if let Some(arr) = self.codex.as_array_mut() { arr.push(entry); }
            }

            // Encounter cues last (after the move action cue AND any turn-end cues).
            for r in encounter_refs {
                cues.push(PresentationCue::Encounter {
                    mob: r,
                    room: EntityRef { id: room.0.clone(), name: room_name.clone() },
                    sound: None,
                });
            }
        }
        Ok(())
```

Delete the now-moved code: the pre-`record_action` `is_player` scan block, the visited-mark + room-codex block, and the old trailing encounter-cue loop. Keep the base-move code (exit/enter scenes, occupant swap, visibility cue, history push, action cue) and `record_action` exactly where they are. `room_name` is already computed above `record_action` (~:336) — keep it.

> Note: the `is_player` binding (~:249-253) must be computed before `record_action` (it reads `self.characters`); keep it where it is. The visited-mark now lives entirely inside `maybe_spawn`, so remove the old visited-mark block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p wickedways-core player_move_into_fresh_room_spawns_and_encounters`
Expected: PASS.

- [ ] **Step 5: Full crate tests + `no_std` (regression guard)**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS + SUCCESS. The existing `entering_a_room_with_a_live_mob_emits_encounter_cue_and_codex` and any move/encounter tests must still pass (the restructure is behavior-preserving for non-spawning moves).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/movement.rs
git commit -m "refactor(core): run player-move tail (spawn/encounters/codex) after record_action (6c-3)"
```

---

## Task 4: Spawn differential fixture

**Files:**
- Create: `conformance/fixtures/formation-shadow.ts`, `conformance/fixtures/spawn.gen.test.ts`, `conformance/spawn.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (add `spawn.gen.test.ts` to the include allowlist)

**Interfaces:**
- Consumes: the Rust `conformance:wraith` formation + `maybe_spawn` (compiled into the wasm via `pnpm run wasm:build` which enables `--features conformance`).
- Produces: the `spawn.*` fixtures + a passing differential replay.

- [ ] **Step 1: Create the TS formation shadow**

Create `conformance/fixtures/formation-shadow.ts`:

```ts
/**
 * TS "shadow" of the Rust `conformance:wraith` FormationBehavior
 * (crates/wickedways-core/src/world/formations.rs). `build` returns one fixed mob
 * with the SAME deterministic id the Rust `build_wraith` assigns. `maybeSpawn` sets
 * origin "campaign" AFTER build, so the shadow does not set origin.
 */
import type { FormationBehavior } from "wickedways/lib/serialization/registry";
import { Mob } from "wickedways/lib/character/mob";
import { StatType } from "wickedways/lib/character/stats";
import type { CharacterId } from "wickedways/lib/character/character";

export const WRAITH_KEY = "conformance:wraith";
export const WRAITH_ID = "campaign-mob:wraith";

export const wraithFormationShadow: FormationBehavior = {
  build: (campaign) => {
    const mob = new Mob({
      campaign,
      name: "Wraith",
      stats: { [StatType.Health]: 4, [StatType.Energy]: 3 },
      inventorySlots: 0,
      actionsPerRound: 1,
      drops: [],
    });
    mob.id = WRAITH_ID as CharacterId;
    return [mob];
  },
};
```

> The exact `Mob` constructor args must produce a serialized mob byte-identical to the Rust `build_wraith` snapshot. Cross-check the `Mob` constructor signature (`src/lib/character/mob.ts`) and the `mob-defeat` fixture's mob authoring; adjust stats/slots/actionsPerRound so the two sides match. Divergences are resolved at Step 4 by fixing the Rust `build_wraith` (or the shadow, if the shadow is the unfaithful side) — never the golden.

- [ ] **Step 2: Create the generator**

Create `conformance/fixtures/spawn.gen.test.ts`, modeled on `conformance/fixtures/keyed-exit.gen.test.ts` (catalog exporter, `viewProjected`, cue drain, `structuralClone` from `./gen-helpers.ts`, `writeFileSync` layout). Specifics:

- Map: **Foyer** (lit, start room, scene-free) → North → **Crypt** (lit; carries a `conformance:visit-counter` enter-scene with `initialState { count: 0 }`, to prove silent placement scene firing).
- Registry: `defineRegistry({ scenes: { [VISIT_COUNTER_KEY]: visitCounterShadow }, formations: { [WRAITH_KEY]: wraithFormationShadow } })` (import `visitCounterShadow`/`VISIT_COUNTER_KEY` from `./scene-shadow.ts`).
- `authorTemplate(..., { rng, maxRounds: 10, baseEncounterChance: 100, now: () => 0 })`, then `.formation(WRAITH_KEY, { weight: 1 })`, `.room(...)`, `.startRoom("Foyer")`, `.exit("Foyer", North, "Crypt")`, `.scene("Crypt", VISIT_COUNTER_KEY, { phase: "enter", initialState: { count: 0 } })`.
- No items → `catalog = { items: {}, aliases: {} }`.
- Command stream (single PC "Mara"):

```ts
const commands: Command[] = [
  { kind: "startTurn" },
  { kind: "go", dir: Directions.North }, // Foyer→Crypt: PC entry fires Crypt.enter (cue "visit 1", count 0→1);
                                          //   after record_action: maybe_spawn spawns Wraith (roll 100≤100),
                                          //   placement fires Crypt.enter SILENTLY (count 1→2, no cue);
                                          //   NOTE_ENCOUNTERS emits an encounter cue for the Wraith.
  { kind: "go", dir: Directions.South }, // Crypt→Foyer
  { kind: "go", dir: Directions.North }, // Foyer→Crypt again: already visited → NO second spawn;
                                          //   Wraith already encountered → NO second encounter cue.
];
```

> Budget is 3/round; three `go`s exactly reach the cap on the third — acceptable (the third `go`'s `record_action` auto-ends the turn; with no mechanics registered the turn-end is silent). If turn-end cues appear and complicate assertions, insert `{ kind: "nextPlayer" }` + `{ kind: "startTurn" }` to split rounds.

- Self-validation (hard throws): step-1 mechanic cues `["The Crypt stirs (visit 1)."]` (only the PC-entry scene cue; the spawn placement is silent), step-1 contains an `encounter` cue for `campaign-mob:wraith` after the move action cue, step-1 snapshot has the Wraith in `characters` and in Crypt's `occupant_ids` with `origin: "campaign"`, and Crypt's enter-scene `state.count === 2` (PC entry + silent spawn placement). Final step: no second Wraith in `characters` (single spawn), no second encounter cue for the Wraith (dedup), and Crypt's scene count reflects only the re-entries that actually fired (assert the exact value you observe and pin it).

- [ ] **Step 3: Generate the golden**

Run: `pnpm run fixtures:gen`
Expected: self-validation passes; `spawn.start.snapshot.json`, `spawn.catalog.json`, `spawn.golden.json` written. (Add `spawn.gen.test.ts` to `conformance/fixtures/vitest.config.ts`'s include list first, or the generator is skipped.)

- [ ] **Step 4: Create the replay test + run the differential**

Create `conformance/spawn.test.ts` (copy `conformance/keyed-exit.test.ts`, swap basenames to `spawn`).

Run: `pnpm run wasm:build && pnpm run test:conformance`
Expected: the `spawn` differential is GREEN and all existing conformance tests pass. If it diverges, report the exact step/field and fix the Rust `build_wraith`/`maybe_spawn` (or a faithful shadow error) — never the golden/comparator. The likely first divergence is a `CharacterSnapshot` field mismatch between `build_wraith` and the TS `Mob` — reconcile field-by-field.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/formation-shadow.ts conformance/fixtures/spawn.gen.test.ts conformance/spawn.test.ts conformance/fixtures/spawn.start.snapshot.json conformance/fixtures/spawn.catalog.json conformance/fixtures/spawn.golden.json conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): encounter-spawn differential fixture (6c-3)"
```

---

## Task 5: Mob drop-on-defeat fixture (equipped item + key)

**Files:**
- Create: `conformance/fixtures/mob-drop.gen.test.ts`, `conformance/mob-drop.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (add `mob-drop.gen.test.ts`)

**Interfaces:** Consumes the existing `on_knock_out` drop logic (`combat.rs:72-127`).

- [ ] **Step 1: Create the generator**

Create `conformance/fixtures/mob-drop.gen.test.ts`, modeled on `conformance/fixtures/mob-defeat.gen.test.ts` (which already defeats a mob and asserts the `${mob.id}:remains` loot box). Extend it so:
- A **room-origin** mob holds an item that is **equipped** (author the mob with a drop item and equip it) AND holds a **key**. Defeat it; assert the `${mob.id}:remains` box contains the item (still `equipped: true` — no unequip, faithful to `mob.ts:198-206`) and the key.
- A **campaign-origin** mob (set origin "campaign") holding a key is defeated; assert its remains box does NOT contain the key (`keys = origin === "room" ? [...] : []`).

Use `structuralClone` for captures. Reuse the mob-defeat generator's catalog/viewProjected helpers.

> Cross-check how to author an equipped mob item and a mob key via the authoring template / assembler (`assembler.ts` mob drops are `${mobId}:drop#i`). If equipping a mob's item is not expressible through the authoring surface, seed the equipped state directly in the generated start snapshot before writing it (document the seam in the file header). The keys-only-for-room-origin split is the load-bearing assertion.

- [ ] **Step 2: Generate + replay**

Run: `pnpm run fixtures:gen` (self-validation passes; three `mob-drop.*` files written) then create `conformance/mob-drop.test.ts` (copy the keyed-exit replay shape, basenames `mob-drop`) and run `pnpm run wasm:build && pnpm run test:conformance`.
Expected: GREEN. Divergences fixed in Rust (`on_knock_out`) or a faithful fixture correction, never the golden.

- [ ] **Step 3: Commit**

```bash
git add conformance/fixtures/mob-drop.gen.test.ts conformance/mob-drop.test.ts conformance/fixtures/mob-drop.start.snapshot.json conformance/fixtures/mob-drop.catalog.json conformance/fixtures/mob-drop.golden.json conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): mob drop-on-defeat (equipped item + room-origin key) fixture (6c-3)"
```

---

## Task 6: sees-in-dark visibility fixture

**Files:**
- Create: `conformance/fixtures/sees-in-dark.gen.test.ts`, `conformance/sees-in-dark.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (add `sees-in-dark.gen.test.ts`)

**Interfaces:** Consumes `require_visible_target` (`combat.rs:144-153`) + `sees_in_dark` (`view.rs:185-187`).

- [ ] **Step 1: Create the generator**

Create `conformance/fixtures/sees-in-dark.gen.test.ts`, modeled on `conformance/fixtures/combat.gen.test.ts`. A **dark** room contains a `lightAverse: true` (seesInDark) mob and a target the mob can attack. The mob attacks the target in the dark and **succeeds** (the positive `requireVisibleTarget` path — a non-seeing actor would throw "Cannot attack in the dark", but that negative path stays unit-tested, not in the golden). Assert the attack produces its normal damage/cues in the dark room (proving `seesInDark` bypassed the visibility gate). Use `structuralClone` for captures.

> Keep it minimal — one dark room, one light-averse attacker, one target, one attack command. The assertion that matters: the attack lands (damage applied, attack cue emitted) despite `!room.isLit`.

- [ ] **Step 2: Generate + replay**

Run: `pnpm run fixtures:gen` then create `conformance/sees-in-dark.test.ts` (keyed-exit replay shape, basenames `sees-in-dark`) and run `pnpm run wasm:build && pnpm run test:conformance`.
Expected: GREEN. Divergences fixed in Rust, never the golden.

- [ ] **Step 3: Commit**

```bash
git add conformance/fixtures/sees-in-dark.gen.test.ts conformance/sees-in-dark.test.ts conformance/fixtures/sees-in-dark.start.snapshot.json conformance/fixtures/sees-in-dark.catalog.json conformance/fixtures/sees-in-dark.golden.json conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): sees-in-dark attack-in-dark visibility fixture (6c-3)"
```

---

## Task 7: README + full gate

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Document encounter spawning**

In `README.md`, add an encounter-spawning subsection near the mobs/encounters section: the `FormationBehavior` registry (`build` → deterministic-id mobs); `maybe_spawn`'s gating (first-visit-only + unconditional visited mark, active-occupant guard, no-formations guard, `threshold = clamp(baseChance * spawnModifier, 0, 100)`, `roll(100)` then weighted select); placement (origin "campaign", inserted into characters + occupants, room enter-scenes fired **silently**); and the `PlayerCharacter.move` ordering (spawn → NOTE_ENCOUNTERS → room codex, after `record_action`, encounter cues last). Note the v1 simplifications (rng-free build, integer `spawnModifier`).

- [ ] **Step 2: Full gate**

Run: `pnpm run checks:phase3 && pnpm run fixtures:stable`
Expected: BOTH EXIT 0.

- [ ] **Step 3: Confirm only intended fixture changes**

Run: `git status --short conformance/fixtures`
Expected: only the new `spawn.*`, `mob-drop.*`, `sees-in-dark.*`, `formation-shadow.ts` files and the `vitest.config.ts` include edit — no other golden churn.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(6c-3): document encounter spawning; full gate green"
```

---

## Self-Review

**Spec coverage:**
- `FormationBehavior` trait + registry + conformance formation → Task 1. ✅
- `World::maybe_spawn` (visited/occupant/formation/roll/select/build/place, silent scenes) → Task 2. ✅
- `move_to` player-tail restructure (after `record_action`) → Task 3. ✅
- `[PLACE]`-path silent scene firing → Task 2 (inside `maybe_spawn`). ✅
- Spawn differential fixture (deterministic-id mob, silent placement scene, encounter cue, dedup, first-visit-only) → Task 4. ✅
- Mob-drop fixture (equipped item + room-origin key; campaign-origin no key) → Task 5. ✅
- sees-in-dark visibility fixture → Task 6. ✅
- Docs + full gate + no golden churn → Task 7. ✅
- Deferred (deposit_materials fractional, 6c-2 minors, build-rng, fractional spawnModifier) → noted, not implemented. ✅

**Placeholder scan:** every code step carries complete code; the fixture tasks (4-6) reference concrete existing fixtures to mirror and give exact map/stream/assertions, with cross-check guards (not placeholders — the exact ids/keys/values are specified).

**Type consistency:** `FormationBehavior::build(&self, &CampaignView) -> Vec<CharacterSnapshot>`; `formation(key) -> Option<&'static dyn FormationBehavior>`; `maybe_spawn(&mut self, &RoomId, &Catalog) -> Result<Vec<CharacterId>, ProceduralViolation>`; `crate::dice::roll(u32, f64) -> u32`; `origin: Option<Value>` set to `Some(json!("campaign"))`. Registry key `"conformance:wraith"` + mob id `"campaign-mob:wraith"` match across `formations.rs`, `formation-shadow.ts`, and the generator.
