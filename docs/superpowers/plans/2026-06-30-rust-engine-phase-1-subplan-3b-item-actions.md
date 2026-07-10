# Rust Engine Core — Phase 1, Sub-plan 3b (Item Actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the six player item actions (`take`, `drop`, `open`, `equip`, `unequip`, `use`) as `Command` variants + `World` mutators, retire the `view_thin` coexistence, and gate the lot with an item-action command-stream differential test.

**Architecture:** Item mutators live on `World`, catalog-resolved (3a), emitting cues into the `&mut Vec<PresentationCue>` sink and appending typed history. `apply_command` dispatches the six commands to the active character and threads a `&mut BTreeSet<String>` `opened` set (harness state — Open adds, Take auto-adds). `replay_commands` is switched from `view_thin` to the widened `view` (gaining catalog + opened params); `view_thin` is deleted and the turn-movement golden regenerated under `view`.

**Tech Stack:** Rust (edition 2021), serde 1 + serde_json 1, ts-rs 10.1, wasm-bindgen 0.2 / wasm-pack 0.15 (`--target nodejs`), TypeScript + vitest 4, pnpm 9.15.6.

## Global Constraints

- **Commit only on the existing branch `design/rust-engine-core`.** Never create, switch, or rename a branch.
- **`no_std`-friendly core.** `wickedways-core` builds with `--no-default-features`; use `alloc::{string::String, vec::Vec, collections::{BTreeMap, BTreeSet}}` — never `std::` in library code. Gate runs `cargo build -p wickedways-core --no-default-features`.
- **serde byte-compatibility + exact-equality canonical-JSON conformance** (invariant 3). Integer fields integer-typed (`i64`); never `f64`. The `i64`→`bigint` binding mismatch stays the deferred pre-Phase-2 decision — do NOT switch types here.
- **Illegal operations throw `ProceduralViolation`** (equip non-equippable, drop key/required item, use non-usable, take in the dark, etc.), mirroring the TS engine.
- **Gating is a pass-through** here — no afflictions until sub-plan 4, so the `attemptAction` equivalent always allows; but the budgeted/free status and history/budget tick points MUST match the TS byte-for-byte (`actions_this_round`, `history` are snapshot fields).
- **`opened` is harness state, not World state** — never add it to `World`/the snapshot; thread it through `apply_command`/`replay_commands` exactly as `GameSession.opened` behaves.
- **Do NOT run `pnpm run fixtures:gen` casually** (it regenerates all fixtures with fresh UUIDs); when a task regenerates, restore fixtures it should not have touched and verify `git status`.
- **Do NOT Read subagent JSONL output files.** `.superpowers/` is gitignored.

---

## File structure

**Modified (Rust, `crates/wickedways-core/src/world/`):**
- `items_actions.rs` (new) — `equip`/`unequip`/`take`/`drop`/`use_item` mutators on `World` (or split across `resolve.rs`/a new module; keep item actions together).
- `equipment.rs` (new) — `EquipmentSlot` constants, `SLOT_KIND` map, `DEFAULT_EQUIPMENT_SLOTS` fill order, `slot_kind_of`/`eligible_slots` helpers.
- `command.rs` — extend `Command` (+ `Take`/`Drop`/`Open`/`Equip`/`Unequip`/`Use`) and `apply_command` (dispatch + `opened` threading).
- `view.rs` — DELETE `view_thin`/`ThinViewModel`/`ThinOccupant`/`ThinStatus` (redundant once `replay_commands` uses `view`).
- `mod.rs` — module wiring.

**Modified (WASM):** `crates/wickedways-wasm/src/lib.rs` — `replay_commands` switches to `view` (gains `catalog_json` + threads `opened`); `view_model` unchanged.

**Modified (conformance, TS):**
- `conformance/fixtures/items-projection.gen.test.ts` — extend to also drive an item-action command stream and emit an item-action golden (or a sibling `items-actions.gen.test.ts`).
- `conformance/fixtures/turn-movement.gen.test.ts` — its `view` helper now emits the widened `view` shape (item fields empty); regenerate `turn-movement.golden.json`.
- `conformance/turn-movement.test.ts` — pass `catalog` (empty) + `opened` to `replay_commands`; compare against the regenerated golden.
- `conformance/items-actions.test.ts` (new) — the item-action differential gate.
- `conformance/canonical-json.ts` — only if multi-equip `equippedNames` ordering needs canonicalization.
- `package.json` — `fixtures:gen` includes the item-action generator.

---

## Task 1: Equipment slots + equip/unequip

**Files:** Create `crates/wickedways-core/src/world/equipment.rs`, `crates/wickedways-core/src/world/items_actions.rs`; modify `world/mod.rs`. Test: co-located.

**Interfaces — Produces:** in `equipment.rs`: `EquipmentSlot` string constants + `DEFAULT_EQUIPMENT_SLOTS: [&str; 12]` (canonical fill order) + `slot_kind_of(slot: &str) -> Option<SlotKind>`. On `World`: `equip(&mut self, actor: &CharacterId, item: &ItemId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>` and `unequip(&mut self, actor, item, cat, cues) -> Result<(), ProceduralViolation>`. Both **free** (no budget tick, no history).

**Reference:** `src/lib/equipment.ts:16-73` (EquipmentSlot / SLOT_KIND / DEFAULT_EQUIPMENT_SLOTS fill order), `character.ts:685-747` (equip), `:756-773` (unequip). Equipped-ness is the equipment slot map (3a); there is no separate `equipped` flag in Rust.

**equip logic to mirror EXACTLY:**
1. item must be in `inventory.item_ids` (else `ProceduralViolation`); resolved `properties.equippable` true; resolved `slot` is `Some` (else throw).
2. if already equipped (id already in the equipment map values), unequip it first (visibility suppressed).
3. **two-handed weapon** (`resolved.r#type == Weapon && two_handed == Some(true)`): unequip any occupants of `leftHand`/`rightHand`, then set BOTH `leftHand` and `rightHand` to the item; emit one net visibility-flip cue.
4. else: `eligible` = the character's slots (use `DEFAULT_EQUIPMENT_SLOTS` — confirm the character has no custom slot set; if archetypes define slots, read them, else default) filtered by `slot_kind_of(s) == Some(item.slot)`; empty → throw. Slot = **first eligible with no occupant in canonical order, else `eligible[0]`** (displace). If that slot holds a different item, unequip it (auto-swap). Set the slot to the item. Emit one net visibility-flip cue.

**unequip:** item held + equipped (in the map values) else throw; remove the item from EVERY slot it occupies (two-handed frees both hands); visibility-flip cue.

**Visibility-flip cue:** emit `{ kind: "visibility", room, lit }` iff the current room is dark and its `is_lit` changed across the (un)equip (a light item entering/leaving the equipment changes carried-light — but occupant-carried light folds in with sub-plan 4's `is_lit` widening; for 3b, `is_lit = !dark || !light_source_ids.is_empty()` (3a) does NOT yet depend on equipped light, so equipping a light does NOT flip `is_lit` yet). **So in 3b no equip/unequip actually flips lit state** — implement the flip-cue check (compute `is_lit` before/after, emit if changed) for fidelity, but expect it to be a no-op in the corpus until sub-plan 4 makes `is_lit` occupant-light-aware. Document this.

- [ ] **Step 1: Write failing tests** — equip an equippable weapon → its id in the equipment map under a hand slot, no budget tick, no history; equip a second finger-slot item → correct eligible finger slot; equip non-equippable → `Err`; equip unheld → `Err`; two-handed weapon occupies both hands; auto-swap displaces a same-slot occupant (evicted item stays in inventory); unequip removes from all slots. (Hand-built `World`+`Catalog`; put item ids in `inventory.item_ids`.)
- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core equip`. Expected: FAIL.
- [ ] **Step 3: Implement** `equipment.rs` + the two mutators.
- [ ] **Step 4: Run + no_std** — `cargo test -p wickedways-core` ; `cargo build -p wickedways-core --no-default-features`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): equip/unequip + equipment slots (sub-plan 3b)"`

> **Fidelity note for the implementer:** the slot-assignment order (`DEFAULT_EQUIPMENT_SLOTS` canonical order → first-free → else displace `eligible[0]`) is byte-compared via the equipment map + `equippedNames` at Task 7. Transcribe it exactly. Confirm whether the character's slot set is the default or archetype-derived; the bespoke campaign should use the default humanoid set.

---

## Task 2: take

**Files:** modify `items_actions.rs`, `world/mod.rs`. Test: co-located.

**Interfaces — Produces:** `World::take(&mut self, actor: &CharacterId, target: &ItemId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`. **Budgeted** (`pickUp` history). Returns the loot container id taken from (so `apply_command` can auto-open it) OR takes/returns nothing extra and `apply_command` locates the container — decide and keep consistent with Task 4.

**Reference:** `player-character.ts:216-235` (takeFromLootBox), `character.ts:547-573` (addToInventory: `pickUp` history + budget), `:250-271` (requireVisibleTarget), `loot.ts` (removeItems).

**Logic:** find the loot container in the actor's current room whose `content_ids` contains `target` (else `ProceduralViolation`); **visibility gate**: `!is_lit(room) && !sees_in_dark(actor)` → `ProceduralViolation("Cannot loot in the dark")` (`sees_in_dark` = false for players until sub-plan 4 — hardcode false with a TODO); check the taker `has_room_for_item` (non-key: `inventory.item_ids.len() < slots`); move `target` from the loot's `content_ids` → the taker's `inventory.item_ids` (keys → `key_ids`); tick the budget + append `ActionHistoryEntry::PickUp { round, items: [ItemRef] }`; emit the `action`(`pickUp`) cue. (`teaches`→discoverRecipe deferred to sub-plan 5 — the conformance items carry none.)

- [ ] **Step 1: Write failing tests** — take an item from a room loot container → item moves to inventory, removed from loot `content_ids`, `actions_this_round` +1, `history` gets a `PickUp` entry, an `action`(`pickUp`) cue emitted; take when the room is dark → `Err`; take a nonexistent/absent target → `Err`; take when inventory full → `Err`.
- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core take`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run + no_std.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core): take (loot -> inventory, visibility-gated, pickUp) (sub-plan 3b)`

---

## Task 3: drop + use

**Files:** modify `items_actions.rs`. Test: co-located.

**Interfaces — Produces:** `World::drop_item(&mut self, actor, target, cat, cues) -> Result<(), ProceduralViolation>` and `World::use_item(&mut self, actor, target, cat, cues) -> Result<(), ProceduralViolation>`. Both **budgeted** (both record a `drop` history entry).

**Reference:** `character.ts:583-604` (removeFromInventory → `drop` history), `inventory.ts:607-631` (use wrapper), `character.ts:440-442` (`CONSUME_VIA_USE` → removeFromInventory).

**drop_item:** target must be in `inventory.item_ids`; **keys throw** (`resolve` type == Key → `ProceduralViolation("Keys cannot be dropped")`); **required item** (`resolved.properties.droppable == Some(false)`) → `ProceduralViolation`; remove from `inventory.item_ids` (the item orphans in the item store — the engine does NOT add it to a room pile; confirm against `relinquishItem` and mirror); tick budget + append `ActionHistoryEntry::Drop { round, items: [ItemRef] }`; emit `action`(`drop`) cue.

**use_item:** target must be held; resolved `properties.usable` true (else `ProceduralViolation`); (KO check — no KO until sub-plan 4, skip with a TODO); author use-behavior is noop + no engine stat effect (confirmed) + `grantsImmunity` deferred → so `use` == **consume**: remove from `inventory.item_ids`, tick budget, append `ActionHistoryEntry::Drop { round, items: [ItemRef] }` (the consume records a **drop**, mirroring `CONSUME_VIA_USE`), emit `action`(`drop`) cue.

- [ ] **Step 1: Write failing tests** — drop a droppable item → removed from inventory, `drop` history, budget +1, `drop` cue; drop a key → `Err`; drop a required item (`droppable:Some(false)`) → `Err`; drop unheld → `Err`. use a usable item → removed (consumed), `drop` history, budget +1, `drop` cue; use a non-usable → `Err`; use unheld → `Err`.
- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core "drop|use"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run + no_std.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core): drop + use (consume) item actions (sub-plan 3b)`

---

## Task 4: Command dispatch + opened threading

**Files:** modify `command.rs`, `world/mod.rs`. Test: co-located.

**Interfaces — Produces:** extend `Command` (`#[serde(tag="kind", rename_all="camelCase")]`) with `Take { targetId: String }`, `Drop { targetId: String }`, `Open { targetId: String }`, `Equip { targetId: String }`, `Unequip { targetId: String }`, `Use { targetId: String }` (camelCase `targetId`). Change `apply_command` signature to thread the catalog + opened set:
`apply_command(world: &mut World, cmd: Command, cat: &Catalog, opened: &mut BTreeSet<String>, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`.

**Dispatch:** the six item commands resolve `targetId` to an `ItemId`/`LootId` and dispatch to the Task 1-3 mutators on the active character. `Open { targetId }` = add the loot id to `opened` (no World mutation, no cue). `Take` = call `world.take(...)` then **auto-add the taken item's loot-container id to `opened`** (mirroring `GameSession.take`). The pre-existing `StartTurn`/`EndTurn`/`Go`/`NextPlayer` arms keep working (they ignore `cat`/`opened`).

- [ ] **Step 1: Write failing tests** — `{"kind":"take","targetId":"i1"}` and `{"kind":"equip","targetId":"i2"}` deserialize to the right variants; `apply_command(Open{id})` adds `id` to `opened`; `apply_command(Take{...})` moves the item AND adds the container id to `opened`; `apply_command(Equip{...})` equips.
- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core command`. Expected: FAIL.
- [ ] **Step 3: Implement** the enum + `apply_command`. Update the existing sub-plan-2 `apply_command` unit tests + call sites (they now pass a `&Catalog` + `&mut BTreeSet`; use `Catalog::default()` + an empty set where items are irrelevant).
- [ ] **Step 4: Run + no_std** — `cargo test -p wickedways-core`. Expected: PASS (the WASM crate will be updated in Task 5; `cargo test --workspace` may not compile until then — run `-p wickedways-core` only here, and note the WASM crate is fixed in Task 5).
- [ ] **Step 5: Commit** — `feat(core): item command dispatch + opened-set threading (sub-plan 3b)`

> Task 4 changes `apply_command`'s signature, which the WASM `replay_commands` calls — so the WASM crate won't compile until Task 5 updates it. That's expected; keep `cargo test -p wickedways-core` green here, and Task 5 restores the full-workspace build. (Do NOT leave the workspace broken beyond Task 5.)

---

## Task 5: View consolidation (delete `view_thin`, switch `replay_commands` to `view`)

**Files:** modify `crates/wickedways-wasm/src/lib.rs`, `crates/wickedways-core/src/world/view.rs`, `crates/wickedways-core/src/stats.rs` (bindings), `conformance/fixtures/turn-movement.gen.test.ts`, `conformance/turn-movement.test.ts`; regenerate `conformance/fixtures/turn-movement.golden.json`.

**Interfaces:** `replay_commands(start_snapshot_json, commands_json, catalog_json) -> Result<String, JsValue>` — parse the catalog, maintain a local `opened: BTreeSet<String>` across the command loop, call the new `apply_command(world, cmd, &cat, &mut opened, &mut cues)`, and emit the widened `view(&cat, &opened)` per step (key `view`). DELETE `view_thin`/`ThinViewModel`/`ThinOccupant`/`ThinStatus` from `view.rs` + their bindings + the stats.rs export entries.

**This is a cross-gate change — do it atomically so no task leaves a red gate:**
- [ ] **Step 1:** Update `replay_commands` (signature + per-step `view`), remove `view_thin` and the Thin* types + bindings.
- [ ] **Step 2:** Update `turn-movement.gen.test.ts`'s per-step view helper to emit the widened `view` shape (item fields empty; occupants gain `health`; strip `exits`/`lockedDoors`/`defeated`/`status.locationName`/`room.image` as the items generator does), pass an empty catalog, and regenerate `turn-movement.golden.json` via the isolated config. Restore any other clobbered fixtures.
- [ ] **Step 3:** Update `conformance/turn-movement.test.ts` to pass the (empty) `catalog` to `replay_commands` and compare against the regenerated golden.
- [ ] **Step 4:** `pnpm run wasm:build` ; `pnpm run bindings:gen && pnpm run bindings:check` ; `pnpm run test:conformance` (turn-movement + prior suites green under `view`) ; `cargo build -p wickedways-core --no-default-features` ; `cargo test --workspace` (workspace compiles again). All green. Confirm `git status` shows only the intended files.
- [ ] **Step 5: Commit** — `refactor(core): retire view_thin — replay_commands emits widened view (sub-plan 3b)`

---

## Task 6: TS harness — item-action command stream + golden

**Files:** modify `conformance/fixtures/items-projection.gen.test.ts` (or new `items-actions.gen.test.ts`), `conformance/fixtures/vitest.config.ts`, `package.json`. Create (committed): `conformance/fixtures/items-actions.{start.snapshot,catalog,golden}.json`.

**Interfaces — Produces:** an item-action golden `{ commands, steps: [{ command, cues, snapshot, view }] }` produced by driving the engine DIRECTLY (as sub-plan 2 did — NOT `GameSession.execute`): `pc.takeFromLootBox`, `pc.equip`, `pc.unequip`, `item.actions.use`, `pc.removeFromInventory`, and marking the `opened` set for `open`/`take`. The `view` per step is the widened projection (same helper as Task 5).

**The command stream (deterministic):** `startTurn` → `take` (item from the loot container) → `equip` weapon → `equip` a **second** equippable item (multi-equip — different slot kind, to exercise slot assignment + `equippedNames` order) → `unequip` one → `use` the consumable → `drop` an item → `open` (a second container, or re-open) → `nextPlayer`(s). Capture cues via `campaign.onCue` per command; maintain `opened` mirroring `GameSession` (Open adds; Take auto-adds). Include a **dark-room `take` that throws** (assert the `ProceduralViolation`; not a diffed step).

- [ ] **Step 1:** Build the campaign with enough content (a loot container the PC can take from; a weapon + a finger/wrist accessory both equippable so multi-equip exercises two slot kinds; a usable; a droppable item; a dark room with a loot container for the take-block).
- [ ] **Step 2:** Drive the stream, capturing `{command, cues, snapshot, view}` per step. Self-validate: throw if the golden has no equip step, no multi-equip (2 equipped), or the dark-take did not throw.
- [ ] **Step 3:** Wire into `fixtures:gen`; `pnpm run fixtures:gen`; restore clobbered pre-existing fixtures (seed/hollow-house/turn-movement/items-projection). Confirm `git status` shows only the new `items-actions.*` files. Run `test:conformance` twice; goldens stable.
- [ ] **Step 4: Commit** — `test(conformance): item-action command stream + golden (sub-plan 3b)`

---

## Task 7: Differential item-action gate (+ multi-equip ordering)

**Files:** create `conformance/items-actions.test.ts`; modify `conformance/canonical-json.ts` (only if needed), `package.json` (checks alias). Reference: `conformance/turn-movement.test.ts`.

**Interfaces — Consumes:** WASM `replay_commands` (now `view`-emitting, Task 5), the committed `items-actions.*` fixtures (Task 6), `canonicalize`.

- [ ] **Step 1:** Load `items-actions.start.snapshot.json` + `items-actions.catalog.json`; `wasm.replay_commands(snapshot, JSON.stringify(golden.commands), catalog)`; per step `canonicalize`-compare `{cues, snapshot, view}` against the golden; assert step count.
- [ ] **Step 2: Run** — `pnpm run wasm:build && pnpm run test:conformance`. Expected: PASS.
- [ ] **Step 3: MULTI-EQUIP ORDERING — the primary risk.** If the gate fails on `view.inventory.equippedNames` order (Rust iterates the equipment `BTreeMap` in slot-key order; the TS live `Map` iterates equip-insertion order), resolve it: `equippedNames` is an unordered display set, so **sort it in `canonicalize` on both sides** (add `inventory.equippedNames` to the comparator's sort list). Do NOT sort semantically-ordered fields. Re-run. If instead the snapshot `equipment` object diverges, the comparator's key-sort already handles it (object keys) — no change needed. Document whichever resolution applied.
- [ ] **Step 4: If any OTHER field diverges** — that is a real fidelity bug in Tasks 1-3 (a wrong cue, history entry, budget tick, or capability). Diagnose the exact step+field (Rust vs golden), fix in the Rust source (note loudly), or BLOCK with specifics. Do NOT loosen the comparator or edit the golden. (`i64`→`bigint` is not a wire failure — a diverging number is a real value bug.)
- [ ] **Step 5: Full gate** — run the phase checks (rename to `checks:phase3` honestly if desired: `cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run test:conformance`) end-to-end. All green. `git status` clean.
- [ ] **Step 6: Commit** — `test(conformance): item-action differential gate + multi-equip ordering (sub-plan 3b)`

---

## Self-review notes (author)

- **Spec coverage:** equip/unequip (T1), take (T2), drop+use (T3), command dispatch + opened (T4), view consolidation / retire view_thin (T5), item-action harness+golden (T6), differential gate + multi-equip resolution (T7). repair/destroy (materials→5), attack/afflictions/grantsImmunity (→4), read/light/keys (no intent), teaches→discoverRecipe (→5) are explicit non-goals — not in any task.
- **Type consistency:** `EquipmentSlot`/`SLOT_KIND`/`DEFAULT_EQUIPMENT_SLOTS` (T1) → mutators (T1-3) → `Command`+`apply_command`(cat, opened) (T4) → `replay_commands`(view) (T5) → golden (T6) → gate (T7). `apply_command` signature change (T4) ripples to WASM (T5) — sequenced so only T4→T5 briefly holds a workspace-compile gap, closed in T5.
- **Carried notes honored:** retires the 3a `view_thin` coexistence (T5) and the multi-equip ordering watch (T7); `opened` is harness-state; integer-typed (i64→bigint deferred); fixtures:gen footgun handled (T5/T6 restore).
- **Risk watch:** T1 equip slot-assignment fidelity (canonical fill order + auto-swap) and T7 multi-equip `equippedNames` ordering are the two places most likely to need a fix loop; T3's `use`-records-a-`drop` and T2's dark-take-block are the subtle fidelity points.
