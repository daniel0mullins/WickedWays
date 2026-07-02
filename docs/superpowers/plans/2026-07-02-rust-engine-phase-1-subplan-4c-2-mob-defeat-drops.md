# Sub-plan 4c-2: Mob Defeat Drops — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a defeated mob deposit its material drops (into `campaign.materials` + the codex) and drop its inventory into a `${mob.id}:remains` loot box, plus emit encounter cues + mob codex records on player room entry and wire `sees_in_dark = light_averse` — verified byte-for-byte by the differential gate.

**Architecture:** `reconcile` (4b) already fires `on_knock_out` once on the false→true KO edge; this plan gives that hook a `CharacterKind::Mob` branch that ports `mob.ts:174-215`. Codex writes reuse a small append-with-dedup helper; the material pool merge is a new helper on the `campaign.materials` JSON value. Encounter cues port `NOTE_ENCOUNTERS` into the player-move path. The loot box is the first runtime-minted entity — its id is context-derived `${mob.id}:remains`, computed identically in TS and Rust (4c-1's scheme), so no counter/serialized-id state is needed.

**Tech Stack:** Rust `no_std` core (`alloc::`) + wasm; TS oracle (`src/`); serde_json; vitest; pnpm.

## Global Constraints

- **The differential gate is the authority.** Fix divergences in Rust source, never by editing goldens or `conformance/canonical-json.ts`.
- **Loot-box id is context-derived `${mob.id}:remains`** — identical in TS (`Mob.onKnockOut`) and Rust (`on_knock_out`). One box per mob (KO edge-triggered once).
- **`on_knock_out` order (mirrors `mob.ts:174-215`):** materials deposit + material codex records FIRST, then item/key drop. Keys drop only if the mob's `origin == "room"`. Box `capacity = items.len() + 2` (keys are stashed *beyond* capacity, not counted). Box `content_ids = items ++ keys`.
- **Codex is append-with-dedup, first-write-wins per `${kind}::${key}`** (material→`material::<component>`, mob→`mob::<name>`), reusing the existing `move_to` pattern. Codex order is significant (the comparator does NOT sort the codex array): on room entry, **mob records precede the room record**.
- **`campaign.materials` merge is additive per component** (`(existing i64 ?? 0) + qty`), port of `DEPOSIT_MATERIALS` (`campaign.ts:580-587`).
- **`NOTE_ENCOUNTERS` fires only for a PLAYER mover, for non-party non-KO occupants, deduped per `${moverId}:${occupantId}` in `campaign.encountered`.** Encounter cues come AFTER the move action cue; mob codex records come BEFORE the room codex record.
- **`sees_in_dark` is not differential-gate-observable in 4c-2** (mobs don't act) — unit-tested only; differential coverage is sub-plan 6.
- **No rng in the mob-defeat path.** `no_std` core; unit tests under DEFAULT features; no_std verified by build.
- **Fixture mob has no `presentation`** → the mob codex `snapshot` omits `presentation` and the encounter cue `sound` is `None` (both sides).
- Deferred to sub-plan 6: encounter spawning, escape, mob-AI turns, `sees_in_dark` differential coverage.

## File Structure

**Rust core (modify):**
- `crates/wickedways-core/src/world/view.rs:182-184` — `sees_in_dark` reads `light_averse`.
- `crates/wickedways-core/src/world/combat.rs` — `record_codex` + `deposit_materials` helpers; the `on_knock_out` Mob branch (loot-box drop).
- `crates/wickedways-core/src/world/movement.rs:151-197` — `NOTE_ENCOUNTERS` (mob codex before room codex) + encounter cues after the move action cue.

**TS oracle (modify):**
- `src/lib/character/mob.ts:207` — set `box.id = ${this.id}:remains` post-construction.

**Conformance (create):**
- `conformance/fixtures/mob-defeat.gen.test.ts`, `conformance/mob-defeat.test.ts`, the three `mob-defeat.*.json` fixtures; register the generator in `conformance/fixtures/vitest.config.ts`.

**Docs:** `README.md` mob/loot section.

---

### Task 1: `sees_in_dark` = `light_averse`

**Files:**
- Modify: `crates/wickedways-core/src/world/view.rs:182-184`
- Test: `crates/wickedways-core/src/world/view.rs` (tests module)

**Interfaces:**
- Produces: `World::sees_in_dark(&self, &CharacterId) -> bool` = the actor's `light_averse` (default false).

- [ ] **Step 1: Write the failing test**

Add to the `view.rs` tests module (it already has `world_two_rooms`/party helpers — mirror an existing view test's setup for constructing a character with `light_averse`):

```rust
#[test]
fn sees_in_dark_follows_light_averse() {
    use crate::world::test_support::world_with_party;
    let mut w = world_with_party(&["pc", "mob"], 10);
    // A light-averse mob sees in the dark; a plain PC does not.
    w.characters.get_mut(&CharacterId("mob".into())).unwrap().light_averse = Some(true);
    assert!(w.sees_in_dark(&CharacterId("mob".into())));
    assert!(!w.sees_in_dark(&CharacterId("pc".into())));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p wickedways-core --lib world::view::tests::sees_in_dark_follows_light_averse`
Expected: FAIL — stub returns `false` for the mob.

- [ ] **Step 3: Implement**

Replace `view.rs:182-184`:

```rust
    /// Mirrors `mob.ts:101-104` (`seesInDark === lightAverse`): a character sees in
    /// the dark iff it is light-averse. Read only when the actor acts (attack/loot in
    /// the dark); mobs don't act in Phase 1, so this is exercised by unit tests here
    /// and by the differential gate in sub-plan 6 (mob turns).
    pub fn sees_in_dark(&self, actor: &crate::world::ids::CharacterId) -> bool {
        self.characters.get(actor).and_then(|c| c.light_averse).unwrap_or(false)
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test -p wickedways-core --lib world::view`
Expected: PASS (new test + existing view tests).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/view.rs
git commit -m "feat(core): sees_in_dark = light_averse (sub-plan 4c-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `record_codex` + `deposit_materials` helpers

Add the codex append-with-dedup helper and the material-pool merge (which uses it for material records).

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs`
- Test: `crates/wickedways-core/src/world/combat.rs` (tests module)

**Interfaces:**
- Produces:
  - `World::record_codex(&mut self, kind: &str, key: &str, snapshot: Value, by: Option<&str>, room: Option<&str>)` — append `{kind, key, snapshot, firstSeen:{round, characterId?, roomId?}}` if no entry with that `(kind, key)` exists.
  - `World::deposit_materials(&mut self, materials: &Value, by: Option<&str>, room: Option<&str>)` — additively merge into `campaign.materials`, then a material codex record per component.

- [ ] **Step 1: Write the failing tests**

Add to the `combat.rs` tests module:

```rust
#[test]
fn deposit_materials_merges_additively_and_records_codex() {
    use serde_json::json;
    let mut w = world_with_party(&["pc"], 10);
    w.campaign.materials = json!({ "metal": 1 });
    w.deposit_materials(&json!({ "metal": 2, "bone": 1 }), Some("pc"), Some("hall"));
    // additive merge
    assert_eq!(w.campaign.materials, json!({ "metal": 3, "bone": 1 }));
    // one codex record per component, deduped by material::<component>
    let codex = w.codex.as_array().unwrap();
    let mats: Vec<_> = codex.iter().filter(|e| e["kind"] == json!("material")).collect();
    assert_eq!(mats.len(), 2);
    let metal = mats.iter().find(|e| e["key"] == json!("metal")).unwrap();
    assert_eq!(metal["snapshot"], json!({ "type": "metal" }));
    assert_eq!(metal["firstSeen"]["characterId"], json!("pc"));
    assert_eq!(metal["firstSeen"]["roomId"], json!("hall"));
    // re-deposit does not duplicate codex records (first-write-wins)
    w.deposit_materials(&json!({ "metal": 5 }), Some("pc"), Some("hall"));
    assert_eq!(w.campaign.materials["metal"], json!(8)); // pool still merges
    let mats2: Vec<_> = w.codex.as_array().unwrap().iter().filter(|e| e["kind"] == json!("material")).collect();
    assert_eq!(mats2.len(), 2); // no new material::metal record
}
```

(`world_with_party` and `json` are already imported in the combat tests module; add `use serde_json::json;` locally if needed.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p wickedways-core --lib world::combat::tests::deposit_materials`
Expected: FAIL to compile (`deposit_materials`/`record_codex` undefined).

- [ ] **Step 3: Implement the helpers**

Add to the `impl World` block in `combat.rs` (add `use serde_json::{json, Value};` to the file's imports if not present):

```rust
    /// Append a codex entry, first-write-wins per `(kind, key)`. Mirrors `codex.ts`
    /// `record()` (:226-232) + `buildEntry`. `firstSeen.characterId`/`roomId` are
    /// omitted when `by`/`room` are `None` (matching TS `by?.id` / `where?.id`).
    fn record_codex(&mut self, kind: &str, key: &str, snapshot: Value, by: Option<&str>, room: Option<&str>) {
        let exists = self.codex.as_array().map(|a| a.iter().any(|e| {
            e.get("kind").and_then(|v| v.as_str()) == Some(kind)
                && e.get("key").and_then(|v| v.as_str()) == Some(key)
        })).unwrap_or(false);
        if exists { return; }
        let round = self.campaign.round;
        let mut first_seen = serde_json::Map::new();
        first_seen.insert("round".into(), json!(round));
        if let Some(b) = by { first_seen.insert("characterId".into(), json!(b)); }
        if let Some(r) = room { first_seen.insert("roomId".into(), json!(r)); }
        let entry = json!({ "kind": kind, "key": key, "snapshot": snapshot, "firstSeen": Value::Object(first_seen) });
        if let Some(arr) = self.codex.as_array_mut() { arr.push(entry); }
    }

    /// Merge a `MaterialMap` additively into `campaign.materials`, then record one
    /// `{kind:"material"}` codex entry per component. Port of `DEPOSIT_MATERIALS`
    /// (`campaign.ts:580-587`) + the material `RECORD_ENCOUNTER` in `Mob.onKnockOut`.
    pub fn deposit_materials(&mut self, materials: &Value, by: Option<&str>, room: Option<&str>) {
        let Some(obj) = materials.as_object() else { return };
        // Ensure the pool is an object.
        if !self.campaign.materials.is_object() {
            self.campaign.materials = json!({});
        }
        // 1. Additive merge.
        if let Some(pool) = self.campaign.materials.as_object_mut() {
            for (component, qty) in obj {
                let add = qty.as_i64().unwrap_or(0);
                let cur = pool.get(component).and_then(|v| v.as_i64()).unwrap_or(0);
                pool.insert(component.clone(), json!(cur + add));
            }
        }
        // 2. One codex record per component (deduped material::<component>).
        let components: Vec<String> = obj.keys().cloned().collect();
        for component in components {
            self.record_codex("material", &component, json!({ "type": component }), by, room);
        }
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs
git commit -m "feat(core): deposit_materials + record_codex helpers (sub-plan 4c-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `on_knock_out` Mob branch (loot-box drop) + TS box id + KO re-fire test

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs:79-81` (the `on_knock_out` stub)
- Modify: `src/lib/character/mob.ts:207`
- Test: `crates/wickedways-core/src/world/combat.rs` (tests module)

**Interfaces:**
- Consumes: `deposit_materials` (Task 2), `active_character_id`, `LootSnapshot { id, description, capacity, content_ids }`, `InventorySnapshot { item_ids, key_ids }`, `CharacterSnapshot.{material_drops: Option<Value>, origin: Option<Value>, current_room_id, inventory, name}`.
- Produces: `on_knock_out` drops a `${mob.id}:remains` box into `world.loot` + `room.loot_ids` for `CharacterKind::Mob`.

- [ ] **Step 1: Write the failing tests**

Add to the `combat.rs` tests module:

```rust
#[test]
fn mob_knockout_drops_materials_and_remains_box() {
    use crate::world::snapshot::{CharacterKind, ItemSnapshot};
    use serde_json::json;
    let mut w = world_with_party(&["hero", "goblin"], 10); // party ["hero","goblin"]; index 0 = hero acts
    // Make goblin a room-origin mob in "hall" with a material drop, one item, one key.
    let gid = CharacterId("goblin".into());
    {
        let c = w.characters.get_mut(&gid).unwrap();
        c.kind = CharacterKind::Mob;
        c.origin = Some(json!("room"));
        c.material_drops = Some(json!({ "bone": 2 }));
        c.current_room_id = Some(RoomId("hall".into()));
        c.inventory.item_ids = alloc::vec![ItemId("mob:goblin:drop#0".into())];
        c.inventory.key_ids = alloc::vec![ItemId("mob:goblin:key#0".into())];
    }
    w.items.insert(ItemId("mob:goblin:drop#0".into()), ItemSnapshot::Item {
        id: ItemId("mob:goblin:drop#0".into()), behavior_key: "items/coin".into(), durability: None, modifier: 0,
    });
    w.rooms.entry(RoomId("hall".into())).or_insert_with(|| test_room("hall")); // helper builds a minimal room; or reuse an existing room fixture helper
    let mut cues = Vec::new();
    // Directly fire the hook as reconcile would on the KO edge, with "hero" as the active attacker.
    w.campaign.active_character_index = 0; // hero
    w.on_knock_out(&gid, &Catalog::default(), &mut cues);

    // materials deposited + codex material record
    assert_eq!(w.campaign.materials["bone"], json!(2));
    // remains box: id = goblin:remains, capacity = items(1)+2 = 3, contents = [item, key]
    let box_id = LootId("goblin:remains".into());
    let b = w.loot.get(&box_id).expect("remains box created");
    assert_eq!(b.description, "goblin's remains");
    assert_eq!(b.capacity, 3);
    assert_eq!(b.content_ids, alloc::vec![ItemId("mob:goblin:drop#0".into()), ItemId("mob:goblin:key#0".into())]);
    // placed in the room; mob inventory emptied
    assert!(w.rooms[&RoomId("hall".into())].loot_ids.contains(&box_id));
    assert!(w.characters[&gid].inventory.item_ids.is_empty());
    assert!(w.characters[&gid].inventory.key_ids.is_empty());
}

#[test]
fn player_knockout_drops_nothing() {
    let mut w = world_with_party(&["hero"], 10);
    let mut cues = Vec::new();
    w.on_knock_out(&CharacterId("hero".into()), &Catalog::default(), &mut cues);
    assert!(w.loot.is_empty());
}

#[test]
fn mob_reknockout_does_not_refire() {
    // Firing on_knock_out twice on the same mob drops exactly one box (edge-trigger is in
    // reconcile; but on_knock_out itself must be idempotent w.r.t. an already-drained mob).
    use crate::world::snapshot::CharacterKind;
    use serde_json::json;
    let mut w = world_with_party(&["hero", "goblin"], 10);
    let gid = CharacterId("goblin".into());
    {
        let c = w.characters.get_mut(&gid).unwrap();
        c.kind = CharacterKind::Mob;
        c.origin = Some(json!("room"));
        c.material_drops = Some(json!({ "bone": 2 }));
        c.current_room_id = Some(RoomId("hall".into()));
        // no items/keys — a materials-only mob keeps the second-fire check simple
    }
    w.rooms.entry(RoomId("hall".into())).or_insert_with(|| test_room("hall"));
    let mut cues = Vec::new();
    w.on_knock_out(&gid, &Catalog::default(), &mut cues);
    w.on_knock_out(&gid, &Catalog::default(), &mut cues);
    // bone deposited twice (deposit is not edge-guarded inside on_knock_out — reconcile is),
    // but the material CODEX record is deduped to one.
    let mats: Vec<_> = w.codex.as_array().unwrap().iter().filter(|e| e["kind"] == json!("material")).count();
    assert_eq!(mats, 1);
}
```

Note on `test_room`: if the combat tests module lacks a room-builder, construct the `RoomSnapshot` inline with the fields the module already uses elsewhere, or add a tiny local `fn test_room(id: &str) -> RoomSnapshot { … }` mirroring `test_support`'s room construction. The reconcile edge-trigger (fire-once) is already proven by 4b's reconcile; `mob_reknockout_does_not_refire` pins the codex-dedup half.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p wickedways-core --lib world::combat::tests::mob_knockout`
Expected: FAIL — `on_knock_out` is a no-op stub; no box created.

- [ ] **Step 3: Implement the Mob branch**

Replace the `on_knock_out` stub (`combat.rs:75-81`). Add imports as needed: `use crate::world::snapshot::{CharacterKind, LootSnapshot}; use crate::world::ids::LootId;`.

```rust
    /// Fired once when KO newly latches during `reconcile`. Players: no-op. Mobs:
    /// deposit materials + drop inventory into a `${mob.id}:remains` loot box. Byte-exact
    /// port of `Mob.onKnockOut` (`mob.ts:174-215`).
    fn on_knock_out(&mut self, actor: &CharacterId, _cat: &Catalog, _cues: &mut Vec<PresentationCue>) {
        let is_mob = self.characters.get(actor)
            .map(|c| matches!(c.kind, CharacterKind::Mob)).unwrap_or(false);
        if !is_mob { return; }

        // Snapshot drop-relevant fields.
        let (material_drops, room_id, is_room_origin, item_ids, key_ids, mob_name) = {
            let Some(c) = self.characters.get(actor) else { return };
            (
                c.material_drops.clone(),
                c.current_room_id.clone(),
                c.origin.as_ref().and_then(|v| v.as_str()) == Some("room"),
                c.inventory.item_ids.clone(),
                c.inventory.key_ids.clone(),
                c.name.clone(),
            )
        };

        // 1. Materials deposit + codex records (before the item drop).
        if let Some(md) = &material_drops {
            if md.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                let by = self.active_character_id().ok().map(|c| c.0);
                let room_str = room_id.as_ref().map(|r| r.0.clone());
                self.deposit_materials(md, by.as_deref(), room_str.as_deref());
            }
        }

        // 2. Item/key drop.
        let Some(room) = room_id else { return };
        let keys = if is_room_origin { key_ids } else { alloc::vec::Vec::new() };
        if item_ids.is_empty() && keys.is_empty() { return; }

        // Relinquish from the mob's inventory.
        if let Some(c) = self.characters.get_mut(actor) {
            c.inventory.item_ids.retain(|id| !item_ids.contains(id));
            if is_room_origin {
                c.inventory.key_ids.retain(|id| !keys.contains(id));
            }
        }

        // Create the remains box: id = ${mob.id}:remains, capacity = items.len()+2,
        // contents = items ++ stashed keys (keys pushed beyond capacity, per STASH_DROP).
        let box_id = LootId(alloc::format!("{}:remains", actor.0));
        let capacity = item_ids.len() as i64 + 2;
        let mut content_ids = item_ids;
        content_ids.extend(keys);
        self.loot.insert(box_id.clone(), LootSnapshot {
            id: box_id.clone(),
            description: alloc::format!("{}'s remains", mob_name),
            capacity,
            content_ids,
        });
        if let Some(r) = self.rooms.get_mut(&room) {
            r.loot_ids.push(box_id);
        }
    }
```

- [ ] **Step 4: TS oracle box-id change**

In `src/lib/character/mob.ts`, after `const box = new Loot({ description: \`${this.name}'s remains\`, contents: items });` (line 207), add:

```ts
    box.id = `${this.id}:remains` as LootId;
```

(`LootId` is imported in `mob.ts` already via the `loot` import; if not, add `import type { LootId } from "../loot";`.) This makes the oracle mint the same context-derived id the Rust replay produces. It must be set before `room.loot.set(box.id, box)` (line 214) so the map key is the derived id.

- [ ] **Step 5: Run tests**

Run: `cargo test -p wickedways-core --lib world::combat` then `cargo test -p wickedways-core`
Expected: PASS (new mob-knockout tests + full crate). Also `cargo build -p wickedways-core --no-default-features` clean.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs src/lib/character/mob.ts
git commit -m "feat(core): mob onKnockOut drops materials + remains loot box (sub-plan 4c-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `NOTE_ENCOUNTERS` on player room entry

Emit encounter cues + mob codex records when a player enters a room with live non-party occupants. Codex mob records go BEFORE the room codex record; encounter cues go AFTER the move action cue.

**Files:**
- Modify: `crates/wickedways-core/src/world/movement.rs:151-222`
- Test: `crates/wickedways-core/src/world/movement.rs` (tests module)

**Interfaces:**
- Consumes: `record_codex` (Task 2), `is_ko`, `entity_ref_char`, `PresentationCue::Encounter { mob, room, sound }`, `campaign.encountered: Vec<CharacterId>` (or `Vec<String>` — match its declared type).
- Produces: on player room entry, one `Encounter` cue + one `mob::<name>` codex record per newly-seen non-party non-KO occupant.

- [ ] **Step 1: Write the failing test**

Add to the `movement.rs` tests module (it has `world_two_rooms`; extend by seating a mob in the destination):

```rust
#[test]
fn entering_a_room_with_a_live_mob_emits_encounter_cue_and_codex() {
    use crate::world::snapshot::CharacterKind;
    use crate::presentation::PresentationCue;
    let mut w = world_two_rooms(/*next_dark=*/false);
    // Seat a live mob "grue" in the destination room "next".
    seat_mob(&mut w, "grue", "next"); // helper: insert a Mob character as an occupant of "next"
    let mut cues = Vec::new();
    w.go(&cid("pc"), Direction::North, &mut cues).unwrap();
    // encounter cue present, after the move action cue
    let move_idx = cues.iter().position(|c| matches!(c, PresentationCue::Action { action: ActionKind::Move, .. })).unwrap();
    let enc_idx = cues.iter().position(|c| matches!(c, PresentationCue::Encounter { .. })).unwrap();
    assert!(enc_idx > move_idx, "encounter cue comes after the move action cue");
    match &cues[enc_idx] {
        PresentationCue::Encounter { mob, room, sound: None } => {
            assert_eq!(mob.id, "grue"); assert_eq!(room.id, "next");
        }
        other => panic!("expected Encounter cue, got {:?}", other),
    }
    // codex: mob record for grue exists AND precedes the room record for "next"
    let codex = w.codex.as_array().unwrap();
    let mob_idx = codex.iter().position(|e| e["kind"] == serde_json::json!("mob") && e["key"] == serde_json::json!("grue")).unwrap();
    let room_idx = codex.iter().position(|e| e["kind"] == serde_json::json!("room") && e["key"] == serde_json::json!("next")).unwrap();
    assert!(mob_idx < room_idx, "mob codex record precedes the room codex record");
    // dedup: the composite key `${mover}:${occupant}` is recorded, so a future entry skips.
    // (Assert the key directly rather than depending on a return exit for a round-trip.)
    assert!(w.campaign.encountered.iter().any(|k| k == "pc:grue"), "encountered key recorded for dedup");
    // Firing the room-entry encounter logic again for the same room produces no second
    // encounter cue: re-run go into a room already entered is dedup-guarded. If world_two_rooms
    // exposes a return exit, move back then North again and assert zero new Encounter cues;
    // otherwise the recorded key above is sufficient proof of the dedup guard.
}
```

Add a `seat_mob(w, name, room)` local helper (or inline): insert a `CharacterSnapshot` with `kind: Mob`, name, `current_room_id: Some(room)`, minimal stats, and push its id into that room's `occupant_ids`. Mirror `test_support`'s character construction. The mob has no `presentation` (so the cue `sound` is `None`). `world_two_rooms` must connect start↔next bidirectionally (it does — North/South).

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p wickedways-core --lib world::movement::tests::entering_a_room_with_a_live_mob`
Expected: FAIL — no encounter cue / no mob codex record yet.

- [ ] **Step 3: Implement `NOTE_ENCOUNTERS`**

In `movement.rs` `move_to`, inside the existing `if is_player {` block, **before** the room codex record (before line 164's `// 2. RECORD_ENCOUNTER({kind:"room"…})` block), compute the newly-encountered occupants, push their mob codex records, and collect their `EntityRef`s for the cues:

```rust
        // NOTE_ENCOUNTERS (campaign.ts:777-792): for each non-party, non-KO occupant of
        // the entered room, deduped per `${mover}:${occupant}` in campaign.encountered,
        // record a mob codex entry (BEFORE the room record) and (later) emit an encounter
        // cue (AFTER the move action cue).
        let mut encounter_refs: Vec<EntityRef> = Vec::new();
        {
            let party: BTreeSet<CharacterId> = self.campaign.party_ids.iter().cloned().collect();
            let occupants: Vec<CharacterId> = self.rooms.get(&room)
                .map(|r| r.occupant_ids.clone()).unwrap_or_default();
            for occ in occupants {
                if party.contains(&occ) { continue; }
                if self.is_ko(&occ) { continue; }
                let key = alloc::format!("{}:{}", actor.0, occ.0);
                if self.campaign.encountered.iter().any(|k| k == &key) { continue; }
                self.campaign.encountered.push(key);
                // mob codex record (deduped mob::<name>), snapshot {name, stats}.
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
        }
```

Then, at the **end** of `move_to`, **after** the move action cue push (after line 221), emit the encounter cues in order:

```rust
        // Encounter cues (after the move action cue, matching TS super.move → NOTE_ENCOUNTERS).
        for r in encounter_refs {
            cues.push(PresentationCue::Encounter { mob: r, room: EntityRef { id: room.0.clone(), name: room_name.clone() }, sound: None });
        }
```

Notes: `campaign.encountered`'s element type — if it's `Vec<String>` use `k == &key`; if `Vec<CharacterId>` the dedup key model differs (the TS key is `${mover}:${occupant}`, a composite string) so `encountered` must hold composite strings — confirm its type is `Vec<String>` (the spec/snapshot lists `encountered: Vec<String>`) and store the composite key. `record_codex` (Task 2) handles the mob-record dedup by `mob::<name>` independently. `room_name` is already computed near the move-cue; reuse it. Add `use alloc::collections::BTreeSet;` if not present. The mob codex `snapshot.stats` uses the mob's base stats (f64; serialize as numbers — comparator parses to match TS integers). `presentation` is omitted (fixture mob has none).

- [ ] **Step 4: Run tests**

Run: `cargo test -p wickedways-core --lib world::movement` then `cargo test -p wickedways-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/movement.rs
git commit -m "feat(core): NOTE_ENCOUNTERS encounter cues + mob codex on room entry (sub-plan 4c-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mob-defeat conformance fixture (`mob-defeat.gen.test.ts`)

Author a fixture where a player moves into a mob's room (encounter cue), attacks it to KO (drops materials + `${mob.id}:remains` box), and loots the remains — then generate the goldens.

**This task mirrors `conformance/fixtures/combat.gen.test.ts`.** Read it first for the harness (assemble/manual PC construction with a shared `mulberry32(SEED)`, cue-capture sink, per-command step recording, golden write). Only the campaign content + command stream + self-validation below are new.

**Files:**
- Create: `conformance/fixtures/mob-defeat.gen.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (register it)

**Campaign content:**
- Two connected lit rooms: `Hall` (start) and `Crypt`. The player starts in `Hall`.
- `Crypt` holds a pre-placed **mob** (room-origin) — authored via the assembler's `mobs` with `room: "Crypt"` — named e.g. `Ghoul`, with: modest stats (defeatable in a couple of hits), `materialDrops: { bone: 2 }`, `drops: ["some-item"]` (one inventory item), NO `presentation`. (A key drop is optional; if included, the mob is room-origin so it drops.)
- One player equipped with a weapon that can KO the Ghoul. `baseEncounterChance: 0`.
- Single shared `mulberry32(SEED)` into the PC + campaign. Keep the PC affliction-free so its attacks never fizzle (no attack-gate rng); the only rng would be the mob's start-turn clear rolls — but the mob never takes a turn, so pick any SEED that yields the intended timeline (brute-force `1..500` if any affliction roll intrudes; likely none).

**Command stream:**
1. `startTurn` (player) → `Go`(to Crypt) → **encounter cue + mob codex** fire on entry.
2. `attack`(Ghoul) one or more times until KO → **materials deposited** (`campaign.materials.bone` grows) + **material codex** + **`ghoul-id:remains` box** dropped into `Crypt.loot_ids`/`world.loot` with the item (+key); Ghoul shows **`defeated:true`** in the view.
3. `take`(the dropped item from the remains box) → item moves to the player's inventory.

**Self-validation (throwing checks in the generator, so a mis-authored stream fails generation):**
```ts
// (a) an encounter cue for the mob fired
if (!golden.steps.some((s) => (s.cues as any[]).some((c) => c.kind === "encounter"))) throw new Error("no encounter cue");
// (b) a mob codex record + a material codex record exist
const anyCodex = (kind: string) => golden.steps.some((s) => ((s.snapshot as any).codex ?? []).some((e: any) => e.kind === kind));
if (!anyCodex("mob")) throw new Error("no mob codex record");
if (!anyCodex("material")) throw new Error("no material codex record");
// (c) campaign.materials gained the deposit
if (!golden.steps.some((s) => ((s.snapshot as any).campaign.materials?.bone ?? 0) > 0)) throw new Error("materials not deposited");
// (d) a `${mob}:remains` loot box exists in world.loot
if (!golden.steps.some((s) => ((s.snapshot as any).loot as any[]).some((l) => String(l.id).endsWith(":remains")))) throw new Error("no remains box");
// (e) the mob shows defeated in a view
if (!golden.steps.some((s) => ((s.view as any).occupants ?? []).some((o: any) => o.defeated === true))) throw new Error("mob never defeated");
```

- [ ] **Step 1: Author the generator + register it**

Create `conformance/fixtures/mob-defeat.gen.test.ts` following the combat template + the content/stream/self-validation above. Register in `conformance/fixtures/vitest.config.ts`.

- [ ] **Step 2: Generate**

Run: `pnpm run fixtures:gen`
Expected: writes `mob-defeat.{start.snapshot,catalog,golden}.json`; no self-validation throw.

- [ ] **Step 3: Isolation**

Run: `git status --porcelain`
Expected: ONLY the four `mob-defeat.*` files + `vitest.config.ts` are new/modified. Restore any other churned fixture with `git checkout -- <path>` (content-derived ids from 4c-1 are stable, so no other fixture should churn). No `packages/seed` change.

- [ ] **Step 4: Commit**

```bash
git add conformance/fixtures/mob-defeat.gen.test.ts conformance/fixtures/vitest.config.ts \
  conformance/fixtures/mob-defeat.start.snapshot.json conformance/fixtures/mob-defeat.catalog.json \
  conformance/fixtures/mob-defeat.golden.json
git commit -m "test(conformance): mob-defeat command stream + golden (sub-plan 4c-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Mob-defeat differential gate + README

**Files:**
- Create: `conformance/mob-defeat.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the differential test**

Create `conformance/mob-defeat.test.ts`, mirroring `conformance/combat.test.ts` exactly but pointing at the `mob-defeat.*` fixtures and passing `golden.seed`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (s: string, c: string, cat: string, seed: number) => string;
};
const start = readFileSync(join(here, "fixtures/mob-defeat.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/mob-defeat.catalog.json"), "utf8");
const golden = JSON.parse(readFileSync(join(here, "fixtures/mob-defeat.golden.json"), "utf8")) as {
  seed: number; commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("mob-defeat differential conformance", () => {
  it("Rust replay matches the TS oracle per step (cues + snapshot + view)", () => {
    const out = JSON.parse(
      wasm.replay_commands(start, JSON.stringify(golden.commands), catalogJson, golden.seed),
    ) as Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
    expect(out.length).toBe(golden.steps.length);
    out.forEach((step, i) => {
      const want = golden.steps[i]!;
      expect(canonicalize(step.cues), `step ${i} cues`).toEqual(canonicalize(want.cues));
      expect(canonicalize(step.snapshot), `step ${i} snapshot`).toEqual(canonicalize(want.snapshot));
      expect(canonicalize(step.view), `step ${i} view`).toEqual(canonicalize(want.view));
    });
  });
});
```

- [ ] **Step 2: Run the differential gate**

Run: `pnpm run test:conformance`
Expected: PASS incl. `mob-defeat differential conformance`. If it diverges, the failing step index localizes the mechanic — **fix the Rust source** (`combat.rs` on_knock_out / `movement.rs` NOTE_ENCOUNTERS / codex order / materials merge); do NOT edit the golden or comparator. Likely-subtle areas: codex order (mob before room), the `${mob.id}:remains` id match, `campaign.materials` merge shape, capacity = items+2 (keys beyond), and the box `content_ids` order (items then keys).

- [ ] **Step 3: README**

Update `README.md`'s mob/loot section: a defeated mob deposits `materialDrops` into the campaign material pool (and codex), and drops its inventory into a `${mob.id}:remains` loot box (keys included only for room-origin mobs); entering a room with a live non-party occupant emits an encounter cue + mob codex record (deduped per viewer:mob); `seesInDark == lightAverse`. Add only what's missing.

- [ ] **Step 4: Full gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 (no_std build + `cargo test --workspace` + `bindings:check` + all conformance suites). Also confirm `pnpm run fixtures:stable` still EXIT 0 (4c-1's idempotence holds with the new fixture).

- [ ] **Step 5: Commit**

```bash
git add conformance/mob-defeat.test.ts README.md
git commit -m "test(conformance): mob-defeat differential gate + README (sub-plan 4c-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Divergences are Rust bugs** (or a faithful fixture/oracle id issue) — fix the source, never the golden or comparator. The differential gate has caught real fidelity bugs every sub-plan.
- **Codex order is significant** (the comparator does NOT sort the codex array): mob records precede the room record on room entry; verify against the gate.
- **`campaign.encountered` element type**: confirm `Vec<String>` and store the composite `${mover}:${occupant}` dedup key. `record_codex` deduping is independent (`mob::<name>`).
- **The `${mob.id}:remains` box id must match TS and Rust** — TS sets `box.id` in `mob.ts`, Rust formats `format!("{}:remains", actor.0)`. The mob id itself is content-derived (`mob:<name>` from 4c-1), so the box is `mob:<name>:remains` on both sides.
- **Fixture mob has no `presentation`** → mob codex snapshot omits `presentation`, encounter cue `sound` is `None`. Keep it that way (a `presentation` field on the mob would need a snapshot field that doesn't exist — out of scope).
