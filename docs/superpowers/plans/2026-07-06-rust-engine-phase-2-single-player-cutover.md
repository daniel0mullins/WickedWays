# Rust Engine Phase 2a+2b — Single-Player WASM Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the single-player game at the Rust/WASM core via a stateful `Authority` handle that owns the ported `execute()` orchestration (turn-wrap + solo-GM mob reactions), gated by a new differential conformance harness whose oracle is the seeded TS `GameSession`.

**Architecture:** The `execute` orchestration (`startTurn → dispatch(intent) → runMobReactions → nextPlayer`) moves from `packages/play-runtime/src/session.ts` into `wickedways-core` as `World::submit`, exposed through a `#[wasm_bindgen] Authority` handle in `wickedways-wasm` (JSON-string marshalling, the proven `replay_commands` idiom). `GameSession` keeps its exact public shape but delegates `execute`/`view`/`read`/`save`/`restore`/`undo` to the handle; TS authoring (`assemble` + `PlayerCharacter` setup) stays and produces a **pre-begin** genesis snapshot that `Authority::new` boots via `begin_campaign`. A `conformance` cargo feature splits the shipped build from the gate build so `conformance:*` ops never ship.

**Tech Stack:** Rust (`wickedways-core` `no_std`+`alloc`, serde, ts-rs 10), wasm-bindgen + wasm-pack (nodejs / bundler targets), TypeScript (NodeNext), Vitest, Vite 8 (`@wickedways/play`), pnpm workspace.

**Design spec:** `docs/superpowers/specs/2026-07-06-rust-engine-phase-2-single-player-cutover-design.md` (authoritative). Master design: `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md`.

## Global Constraints

Every task's requirements implicitly include this section.

- **⚠️ POST-DSL RECONCILIATION (this plan predates the scripted-ops DSL sub-plan, now merged @ `7f9545c`).** The DSL landed underneath this plan and changed shared seams — honor these everywhere:
  - `World::validate_mechanics` now takes **`&Catalog`** (`validate_mechanics(&self, cat: &Catalog)`) — it resolves scripted behaviors from `catalog.behaviors`, not only the native registry. Every call passes the catalog. (Task 7's Authority code is already updated.)
  - `Catalog` gained a `behaviors: BTreeMap<String, BehaviorScript>` field (`#[serde(default, skip_serializing_if = "…is_empty")]`) — old catalog JSON without it still parses, but a real campaign's genesis catalog **must include its scripted behaviors** or `validate_mechanics` rejects it. `boot()` (Task 11) must emit them.
  - `ActionView` is **already widened** with the move room payload (was a prerequisite; DSL Task 8 did it) — the mob-reaction/submit flow reaches existing engine methods that already carry it; no ActionView work remains here.
  - The wasm `replay_commands` **already parses the catalog before `validate_mechanics`** (DSL did the reorder) — no reorder task remains.
  - **Hollow House now BOOTS on the Rust core** (its `dread`/`storyteller`/`status-bar` mechanics, both doors, and 3 victory conditions are scripted in `packages/campaigns/src/hollow-house/scripted.ts` and resolve via `Catalog.behaviors`). The old "known gap: campaigns with custom behaviors can't boot / needs a follow-up ops-port sub-plan" is **RESOLVED** — Task 13's gap note is rewritten accordingly, and the real-surface/e2e validation this plan targets is unblocked.

- **JSON-string boundary.** All `Authority` methods marshal JSON **strings** (the proven `replay_commands` path). Migrating to `serde-wasm-bindgen` is out of scope.
- **`no_std` core stays `alloc`-only.** No new `std` dependency in `wickedways-core`; `cargo build -p wickedways-core --no-default-features` must pass after every task.
- **`conformance:*` registries stay behind `#[cfg(any(test, feature = "conformance"))]`** (mechanic ops, exit/scene/formation/victory behaviors) and **MUST NOT ship in the default wasm build**. The shipped `Authority` build is the default-feature build.
- **The differential gate is the authority.** Fix divergences in Rust source, **NEVER** edit committed golden JSON by hand and **NEVER** edit `conformance/canonical-json.ts`. (Re-running `pnpm run fixtures:gen` after a deliberate, spec'd projection change in a *generator* is the sanctioned regeneration path — the TS oracle still produces every byte of every golden.)
- **Every new `.gen.test.ts` MUST be added to the explicit `include` list in `conformance/fixtures/vitest.config.ts`** — otherwise `fixtures:gen` silently skips it.
- **TS boundary types are generated (ts-rs), never hand-edited.** `generated/bindings/*.ts` come only from `pnpm run bindings:gen`; `pnpm run bindings:check` fails CI on drift. New types `Intent`/`MobAttack`/`ExecuteResult`/`ExitView`/`LockedDoorView` follow the existing `#[cfg_attr(feature = "ts", derive(TS), ts(export))]` idiom.
- **Core-begins lifecycle.** `Authority::new` receives a **PRE-begin** genesis snapshot (assembled + PC placed, `started: false`) and runs `begin_campaign` itself, buffering the round-0 `onRoundStart` cues into a startup buffer read via `take_startup_cues`.
- **`GameSession` keeps its exact public shape** (`start`, `execute`, `view`, `read`, `save`, `restore`, `undo`, `restart`, `takeStartupCues`, `finished`, `outcome`) **minus the removed `campaign` getter**.
- **Error strings must match TS verbatim** — the intent-level legality guards return the exact `session.ts` `ProceduralViolation` messages (listed in Task 4); the facade fixtures verify them byte-for-byte.
- **Determinism.** The rng lives in the `World` inside the handle, is seeded once at `Authority::new`, advances continuously across submits, and **survives `restore`** (mirroring the TS `opts.rng` closure surviving `loadSnapshot`). No wall-clock or ambient randomness in the core.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `crates/wickedways-core/src/world/intent.rs` | `Intent` enum (serde `tag="kind"`, camelCase) + `is_time_advancing` |
| `crates/wickedways-core/src/world/submit.rs` | `MobAttack`, `ExecuteResult`, `World::{run_mob_reactions, submit, dispatch_intent, read_item}` |
| `crates/wickedways-wasm/src/authority.rs` | `#[wasm_bindgen] pub struct Authority` (stateful handle) |
| `crates/wickedways-wasm/tests/authority.rs` | Native (non-wasm) smoke test of the handle's happy paths |
| `scripts/assert-no-conformance.mjs` | Asserts the default wasm build exposes no `conformance:*` symbol/op |
| `conformance/fixtures/oracle-view.ts` | Frozen copy of the live-campaign TS `view()` (oracle survives the cutover) |
| `conformance/fixtures/oracle-session.ts` | Frozen copy of the TS `GameSession` orchestration (the facade oracle) |
| `conformance/fixtures/facade-gen.ts` | Shared facade-golden generator driver (`FacadeOp` stream → steps) |
| `conformance/facade-replay.ts` | Shared `Authority`-driven replay driver (compares result/snapshot/view per step) |
| `conformance/fixtures/facade-mob-combat.gen.test.ts` + `conformance/facade-mob-combat.test.ts` | Fixture: mob-reaction combat (rng-consuming) |
| `conformance/fixtures/facade-free-vs-advancing.gen.test.ts` + `conformance/facade-free-vs-advancing.test.ts` | Fixture: `equip`/`open` free vs `move`/`wait` advancing |
| `conformance/fixtures/facade-ko-piling.gen.test.ts` + `conformance/facade-ko-piling.test.ts` | Fixture: KO stops mob piling |
| `conformance/fixtures/facade-afflicted-mob.gen.test.ts` + `conformance/facade-afflicted-mob.test.ts` | Fixture: blocked mob's violation swallowed |
| `conformance/fixtures/facade-talk.gen.test.ts` + `conformance/facade-talk.test.ts` | Fixture: `talk` → error, no state change |
| `conformance/fixtures/facade-loot.gen.test.ts` + `conformance/facade-loot.test.ts` | Fixture: open/take loot path + `opened` ownership + `read` |
| `conformance/fixtures/facade-legality.gen.test.ts` + `conformance/facade-legality.test.ts` | Fixture: every intent-level legality error string |
| `conformance/fixtures/facade-undo.gen.test.ts` + `conformance/facade-undo.test.ts` | Fixture: save/restore/undo semantics |
| `packages/play-runtime/src/engine-types.ts` | `EngineModule` type (shape of the wasm module) |
| `packages/play-runtime/src/engine-node.ts` | Node engine loader (`pkg-node`, synchronous `createRequire`) |
| `packages/play-runtime/src/engine-web.ts` | Browser engine loader (`pkg-web` bundler target, async one-time init) |
| `packages/play-runtime/src/catalog.ts` | `catalogFromRegistry` — registry items → Rust `Catalog` JSON shape |
| `packages/play-runtime/src/session.test.ts` | Unit tests for the WASM-backed `GameSession` |

**Modified:**

| Path | Change |
|---|---|
| `crates/wickedways-wasm/src/lib.rs` | Gate `mitigator`/`roundtrip_snapshot`/`view_model`/`replay_commands` behind `#[cfg(feature = "conformance")]`; `mod authority` |
| `crates/wickedways-core/src/world/mod.rs` | `pub mod intent; pub mod submit;` |
| `crates/wickedways-core/src/world/view.rs` | Widen `ViewModel`: `exits`, `locked_doors`, `status.location_name`; new `ExitView`/`LockedDoorView` |
| `crates/wickedways-core/src/stats.rs` | `export_typescript_bindings` gains the 5 new types |
| `src/lib/serialization/registry.ts` | Additive `get itemKeys()` enumerator (catalog export needs it) |
| `conformance/fixtures/gen-helpers.ts` | `viewProjected` stops dropping `exits`/`lockedDoors`/`locationName`; imports `view` from `oracle-view.ts` |
| `conformance/fixtures/vitest.config.ts` | Register the 8 new facade generators |
| `conformance/fixtures/*.golden.json`, `*.start.snapshot.json` | Regenerated via `fixtures:gen` after the view-parity widening (Task 6) |
| `packages/play-runtime/src/viewmodel.ts` | Task 6: canonical exit ordering. Task 11: becomes type re-exports over generated bindings (live `view()` deleted) |
| `packages/play-runtime/src/intent.ts` | Re-export generated `Intent`; keep `isTimeAdvancing` |
| `packages/play-runtime/src/session.ts` | Full cutover: delegates to `Authority`; `campaign` getter removed |
| `packages/play-runtime/src/launcher.ts` | `bootLauncher` async, one-time `await initEngine()` |
| `packages/play-runtime/src/audio/{contracts,audio-runtime,default-pack}.ts` | `tension`/`update` take a `ViewModel` DTO, not `ICampaign` |
| `packages/play-runtime/src/index.ts` | Export surface updates (no live `view`) |
| `packages/play-runtime/package.json` | `imports: { "#engine": { browser, default } }` |
| `packages/play-surface/src/crt/controller.ts`, `.../pnc/controller.ts` | `audio.update(vm)` instead of `audio.update(session.campaign)` |
| `packages/play-surface/src/{crt,pnc}/{controller,surface}.test.ts` | Session stubs lose the `campaign` getter |
| `packages/campaigns/src/hollow-house/audio.ts` + `audio.test.ts` | Director `tension(vm)` reads `vm.status.sanity` |
| `packages/play/vite.config.ts` + `package.json` | wasm bundler-target plugins |
| `packages/play/src/main.ts` (or actual boot entry) | `await bootLauncher(...)` |
| `package.json` (root) | Build-split scripts; `checks:phase2` full gate |
| `.gitignore` | `pkg-node/`, `pkg-web/` wasm output dirs |
| `README.md` | Living-docs update (Task 13) |

**Deleted (Task 11):** `packages/play-runtime/src/viewmodel.test.ts` (tested the live-campaign `view()`; coverage moves to the facade differential fixtures + Rust `view.rs` unit tests).

**Deviations from the spec's task sketch (file-read evidence):**

1. **Inserted Task 6 (ViewModel parity).** The Rust `ViewModel` (`crates/wickedways-core/src/world/view.rs:105-118`) has **no `exits`, `lockedDoors`, `status.locationName`** ("deferred to sub-plan 4/6" — never landed), while the surfaces hard-require them (`packages/play-surface/src/shared/narrator.ts:77`, `crt/components/crt-hud.ts:102-108`, `pnc/affordances.ts:34-48`, `pnc/controller.ts:120`, `play-runtime/src/map-model.ts:63-64`). `Authority.view()` cannot back `GameSession.view()` without them. Exit classification needs live engine state (door lock/key evaluation), so it must be core-side.
2. **Reordered: audio DTO retirement (Task 10) lands BEFORE the GameSession cutover (Task 11).** `packages/play-surface/src/crt/controller.ts:123` and `pnc/controller.ts:126` call `audio.update(session.campaign)`; removing the `campaign` getter first would break `pnpm -r typecheck` mid-plan. Pre-cutover, `audio.update(session.view())` works against the TS session too.
3. **The facade oracle is a frozen copy** (`conformance/fixtures/oracle-session.ts` / `oracle-view.ts`), not the live `GameSession`: after Task 11 the live `GameSession` *is* the Rust replica, so generators importing it would self-compare, and `fixtures:gen` would break when Task 11 deletes the live `view()` that `gen-helpers.ts` imports today. The oracle copy drives `src/lib` (which survives until Phase 3) — same pattern as the existing `dread-shadow.ts`/`victory-shadow.ts` oracle shadows.
4. **Task 7's fixture batch is split (Tasks 8 and 9)** per the spec's own allowance — 8 fixtures + a new harness is too large for one reviewer gate.
5. **Room/occupant `image` stays a host-side overlay in `GameSession.view()`** (a boot-time `roomId → image` / `characterId → image` map captured from the assembled TS campaign). Presentation is **not serialized** (`src/lib/serialization/types.ts:64-76` `RoomSnapshot` has no presentation; neither does `CharacterSnapshot`), so the core can never emit it; overlaying host-side matches master-design invariant 6 (surfaces own presentation) and preserves today's fresh-boot behavior. (TS already loses these images on `restore` — that quirk is unchanged.)

---

### Task 1: Conformance-feature build split

**Files:**
- Modify: `crates/wickedways-wasm/src/lib.rs`
- Create: `scripts/assert-no-conformance.mjs`
- Modify: `package.json` (root, `scripts` block)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: existing `conformance` cargo feature in `crates/wickedways-wasm/Cargo.toml:9-13` (`conformance = ["wickedways-core/conformance"]`) — already correct, no Cargo change needed.
- Produces: `pnpm run wasm:build` → default-feature nodejs build in `crates/wickedways-wasm/pkg-node/`; `pnpm run wasm:build:conformance` → conformance nodejs build in `crates/wickedways-wasm/pkg/` (the path `conformance/*.test.ts` already `require`s); `node scripts/assert-no-conformance.mjs` purity check. Later tasks extend the script (Task 7) and scripts (Task 12).

- [ ] **Step 1: Write the failing purity check**

Create `scripts/assert-no-conformance.mjs`:

```js
// Asserts the DEFAULT (no-conformance) wasm build in pkg-node/ is clean:
// no conformance-only free function in the JS glue, and no "conformance:"
// registry key baked into the wasm binary. Extended in Task 7 to also
// require the Authority class. Run after `pnpm run wasm:build`.
import { readFileSync } from "node:fs";

const jsPath = "crates/wickedways-wasm/pkg-node/wickedways_wasm.js";
const wasmPath = "crates/wickedways-wasm/pkg-node/wickedways_wasm_bg.wasm";

const js = readFileSync(jsPath, "utf8");
for (const sym of ["replay_commands", "roundtrip_snapshot", "view_model", "mitigator"]) {
  if (js.includes(sym)) {
    console.error(`FAIL: conformance symbol '${sym}' leaked into the default build`);
    process.exit(1);
  }
}
const wasm = readFileSync(wasmPath);
if (wasm.includes(Buffer.from("conformance:"))) {
  console.error("FAIL: a 'conformance:' registry key is baked into the default wasm build");
  process.exit(1);
}
console.log("OK: default build exposes no conformance symbols");
```

- [ ] **Step 2: Add the split build scripts**

In root `package.json`, replace the existing `wasm:build` line and `test:conformance` line:

```json
"wasm:build": "wasm-pack build crates/wickedways-wasm --target nodejs --out-dir pkg-node",
"wasm:build:conformance": "wasm-pack build crates/wickedways-wasm --target nodejs --out-dir pkg -- --features conformance",
"test:conformance": "pnpm run wasm:build:conformance && vitest run --config conformance/vitest.config.ts",
```

(The conformance build keeps `--out-dir pkg` because every replay harness hardcodes `require("../crates/wickedways-wasm/pkg/wickedways_wasm.js")`.)

Append to `.gitignore` (check first with `grep -n "pkg" .gitignore` — if `crates/wickedways-wasm/pkg` is already ignored, add the two new dirs alongside it):

```
crates/wickedways-wasm/pkg-node/
crates/wickedways-wasm/pkg-web/
```

- [ ] **Step 3: Run the check to verify it FAILS against an ungated build**

```bash
pnpm run wasm:build && node scripts/assert-no-conformance.mjs
```

Expected: `FAIL: conformance symbol 'mitigator' leaked into the default build` (the four functions are still unconditionally exported).

- [ ] **Step 4: Gate the conformance-only free functions**

Rewrite `crates/wickedways-wasm/src/lib.rs` — keep `ping`, `roll`, `mitigated_damage` unconditional (genuinely pure helpers); move `mitigator`, `roundtrip_snapshot`, `view_model`, `replay_commands` (bodies **unchanged**, exactly as they are today at lib.rs:14-113) into a gated module:

```rust
use wasm_bindgen::prelude::*;
use wickedways_core::{compute_mitigated_damage, DamageInput};

/// Toolchain smoke test: proves Rust→WASM→Node loading works end-to-end.
#[wasm_bindgen]
pub fn ping() -> i32 {
    42
}

/// Pure dice roll from a pre-drawn uniform `unit` in `[0, 1)`.
#[wasm_bindgen]
pub fn roll(sides: u32, unit: f64) -> u32 {
    wickedways_core::roll(sides, unit)
}

/// Mitigation formula over the serde boundary. Proves struct marshalling
/// (serde-wasm-bindgen) end-to-end.
#[wasm_bindgen]
pub fn mitigated_damage(input: JsValue) -> Result<f64, JsValue> {
    let parsed: DamageInput = serde_wasm_bindgen::from_value(input)?;
    Ok(compute_mitigated_damage(parsed))
}

/// Conformance-gate-only entry points. Compiled ONLY under `--features
/// conformance` (the `wasm:build:conformance` build); the shipped default
/// build must not carry them (asserted by scripts/assert-no-conformance.mjs).
#[cfg(feature = "conformance")]
mod conformance_api {
    use std::collections::BTreeSet;
    use wasm_bindgen::prelude::*;
    use wickedways_core::{CampaignSnapshot, StatType, World};
    use wickedways_core::world::descriptor::Catalog;

    // ── the four function bodies below are moved VERBATIM from the current
    //    lib.rs:14-113 (mitigator, roundtrip_snapshot, view_model,
    //    replay_commands) — do not re-type them, cut and paste. ──
}
```

(`#[wasm_bindgen]` functions inside an inner module are still exported — wasm-bindgen scans the whole crate.)

- [ ] **Step 5: Verify both builds compile and the check passes**

```bash
pnpm run wasm:build && node scripts/assert-no-conformance.mjs
```
Expected: `OK: default build exposes no conformance symbols`

```bash
node -e "const w=require('./crates/wickedways-wasm/pkg-node/wickedways_wasm.js'); console.log(w.ping(), typeof w.replay_commands)"
```
Expected: `42 undefined`

```bash
pnpm run test:conformance
```
Expected: all existing conformance suites PASS (the gate build still exports everything).

- [ ] **Step 6: Point `checks:phase2` at the split (interim form; finalized in Task 13)**

```json
"checks:phase2": "cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run wasm:build && node scripts/assert-no-conformance.mjs && pnpm run test:conformance",
```

Run: `pnpm run checks:phase2` — Expected: PASS end-to-end.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-wasm/src/lib.rs scripts/assert-no-conformance.mjs package.json .gitignore
git commit -m "build(wasm): split default vs conformance builds; gate conformance-only entry points"
```

---

### Task 2: Core `Intent` type + `is_time_advancing`

**Files:**
- Create: `crates/wickedways-core/src/world/intent.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (module declaration)

**Interfaces:**
- Consumes: `crate::world::direction::Direction` (serde lowercase strings, already TS-exported).
- Produces: `pub enum Intent` and `pub fn is_time_advancing(&Intent) -> bool` at `wickedways_core::world::intent::{Intent, is_time_advancing}`. Task 4's `World::submit(intent: Intent, ...)` and Task 7's `Authority::submit` consume both. JSON shape mirrors `packages/play-runtime/src/intent.ts:3-13` 1:1.

- [ ] **Step 1: Write the failing tests**

Create `crates/wickedways-core/src/world/intent.rs` with the test module first (the type comes in Step 3 — the file won't compile until then, which is the failing state):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn intent_json_shapes_mirror_ts_intent_union() {
        // packages/play-runtime/src/intent.ts:3-13, byte-for-byte field names.
        let cases = [
            json!({ "kind": "move", "dir": "north" }),
            json!({ "kind": "take", "targetId": "i1" }),
            json!({ "kind": "drop", "targetId": "i1" }),
            json!({ "kind": "open", "targetId": "l1" }),
            json!({ "kind": "attack", "targetId": "m1" }),
            json!({ "kind": "equip", "targetId": "i1" }),
            json!({ "kind": "unequip", "targetId": "i1" }),
            json!({ "kind": "use", "targetId": "i1" }),
            json!({ "kind": "talk", "npcId": "n1", "prompt": "hello" }),
            json!({ "kind": "talk", "npcId": "n1" }),
            json!({ "kind": "wait" }),
        ];
        for case in cases {
            let parsed: Intent = serde_json::from_value(case.clone()).unwrap();
            // Round-trip: serialization emits the same JSON (prompt omitted when None).
            assert_eq!(serde_json::to_value(&parsed).unwrap(), case);
        }
    }

    #[test]
    fn talk_prompt_is_optional_and_omitted_when_absent() {
        let t: Intent = serde_json::from_value(json!({ "kind": "talk", "npcId": "n1" })).unwrap();
        assert!(matches!(&t, Intent::Talk { npc_id, prompt: None } if npc_id == "n1"));
    }

    #[test]
    fn time_advancing_set_matches_intent_ts() {
        // intent.ts:15 — TIME_ADVANCING = {move, take, drop, use, attack, wait, talk}
        let advancing = [
            Intent::Move { dir: crate::world::direction::Direction::North },
            Intent::Take { target_id: "x".into() },
            Intent::Drop { target_id: "x".into() },
            Intent::Use { target_id: "x".into() },
            Intent::Attack { target_id: "x".into() },
            Intent::Wait,
            Intent::Talk { npc_id: "x".into(), prompt: None },
        ];
        for i in advancing {
            assert!(is_time_advancing(&i), "{i:?} must advance time");
        }
        let free = [
            Intent::Open { target_id: "x".into() },
            Intent::Equip { target_id: "x".into() },
            Intent::Unequip { target_id: "x".into() },
        ];
        for i in free {
            assert!(!is_time_advancing(&i), "{i:?} must be free");
        }
    }
}
```

- [ ] **Step 2: Run to verify failure**

Add `pub mod intent;` to `crates/wickedways-core/src/world/mod.rs` (after `pub mod ids;`), then:

```bash
cargo test -p wickedways-core intent
```
Expected: COMPILE ERROR — `cannot find type Intent`.

- [ ] **Step 3: Implement the type**

Prepend to `crates/wickedways-core/src/world/intent.rs`:

```rust
//! The surface-facing `Intent` boundary type (Phase 2a).
//!
//! Mirrors `packages/play-runtime/src/intent.ts` 1:1 — the parser-produced
//! player intents. Distinct from `Command` (`world/command.rs`), which
//! additionally carries internal lifecycle ops (startTurn/endTurn/nextPlayer/
//! endCampaign/mechanicAction) and has no `wait`/`talk`; `Command` stays the
//! internal/multiplayer representation.
use alloc::string::String;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::world::direction::Direction;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Intent {
    Move { dir: Direction },
    #[serde(rename_all = "camelCase")]
    Take { target_id: String },
    #[serde(rename_all = "camelCase")]
    Drop { target_id: String },
    #[serde(rename_all = "camelCase")]
    Open { target_id: String },
    #[serde(rename_all = "camelCase")]
    Attack { target_id: String },
    #[serde(rename_all = "camelCase")]
    Equip { target_id: String },
    #[serde(rename_all = "camelCase")]
    Unequip { target_id: String },
    #[serde(rename_all = "camelCase")]
    Use { target_id: String },
    #[serde(rename_all = "camelCase")]
    Talk {
        npc_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        prompt: Option<String>,
    },
    Wait,
}

/// Port of `intent.ts` `isTimeAdvancing`: move/take/drop/use/attack/wait/talk
/// advance the turn; open/equip/unequip are free.
pub fn is_time_advancing(intent: &Intent) -> bool {
    matches!(
        intent,
        Intent::Move { .. }
            | Intent::Take { .. }
            | Intent::Drop { .. }
            | Intent::Use { .. }
            | Intent::Attack { .. }
            | Intent::Wait
            | Intent::Talk { .. }
    )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p wickedways-core intent && cargo build -p wickedways-core --no-default-features
```
Expected: 3 tests PASS; `no_std` build PASSES.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/intent.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): Intent boundary type + is_time_advancing (port of intent.ts)"
```

---

### Task 3: `MobAttack` + `World::run_mob_reactions`

**Files:**
- Create: `crates/wickedways-core/src/world/submit.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (module declaration)

**Interfaces:**
- Consumes: `World::attack(&mut self, actor: &CharacterId, target: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>` (combat.rs:175), `World::effective_stat(&self, character: &CharacterId, stat: StatType, cat: &Catalog) -> f64` (resolve.rs:119), `World::is_ko(&self, id: &CharacterId) -> bool` (view.rs:174), `CharacterKind` (snapshot.rs:95).
- Produces: `pub struct MobAttack { name: String, stat: StatType, amount: f64 }` and `World::run_mob_reactions(&mut self, active: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Vec<MobAttack>` — consumed by Task 4's `submit` and exported to TS in Task 5. Faithful port of `session.ts:148-177` `runMobReactions`.

- [ ] **Step 1: Write the failing tests**

Create `crates/wickedways-core/src/world/submit.rs` with the test module (type + method arrive in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use alloc::collections::BTreeMap;
    use alloc::string::String;
    use crate::stats::StatType;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::formations::conformance::seat_test_mob;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::snapshot::RoomSnapshot;
    use crate::world::test_support::world_with_party;
    use crate::world::World;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }
    fn rid(s: &str) -> RoomId { RoomId(s.into()) }

    /// world_with_party PC (energy 5 / sanity 7 / health 10, 2 actions/round),
    /// placed alone in "room1" (lit).
    fn world_with_pc_in_room() -> World {
        let mut w = world_with_party(&["pc"], 10);
        let pc = cid("pc");
        w.characters.get_mut(&pc).unwrap().current_room_id = Some(rid("room1"));
        w.rooms.insert(rid("room1"), RoomSnapshot {
            id: rid("room1"),
            name: "Test Room".into(),
            description: String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc],
            loot_ids: alloc::vec![],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        });
        w
    }

    #[test]
    fn live_mob_strikes_and_reports_typed_health_delta() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1"); // natural attack default {health, 1}
        let mut cues = Vec::new();
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut cues);
        // strength 1, armor 0, mitigator = effective sanity 7 → (10-7)*0.2 = 0.6 dealt
        assert_eq!(attacks.len(), 1);
        assert_eq!(attacks[0].name, "wraith");
        assert_eq!(attacks[0].stat, StatType::Health);
        assert!((attacks[0].amount - 0.6).abs() < 1e-9, "amount = {}", attacks[0].amount);
        // The strike actually landed on the PC.
        let health = w.effective_stat(&cid("pc"), StatType::Health, &Catalog::default());
        assert!((health - 9.4).abs() < 1e-9);
        // Cues from the attack path were emitted (takeDamage + attack action cues).
        assert!(!cues.is_empty());
    }

    #[test]
    fn ko_mob_does_not_strike() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn ko_active_player_is_not_piled_on_at_entry() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("pc")).unwrap().afflictions.set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn blocked_mob_violation_is_swallowed() {
        // Panic blocks non-move actions (gate.rs:53) — the mob's attack throws,
        // runMobReactions catches ProceduralViolation and skips (session.ts:165-168).
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Panic, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
        // PC untouched.
        assert_eq!(w.characters[&cid("pc")].stats.health, 10.0);
    }

    #[test]
    fn player_ko_mid_loop_stops_further_strikes() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "mob-a", "room1");
        seat_test_mob(&mut w, "mob-b", "room1");
        // sanity 0 → mitigation multiplier 2.0 → each strike deals 2.0 health.
        // health 1 → first strike floors to 0 and latches KO → mob-b must not act.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = 1.0;
            c.stats.sanity = 0.0;
        }
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert_eq!(attacks.len(), 1, "second mob must not pile on");
        assert_eq!(attacks[0].name, "mob-a");
        assert!(w.is_ko(&cid("pc")));
    }

    #[test]
    fn non_mob_occupant_is_skipped() {
        let mut w = world_with_party(&["pc", "ally"], 10);
        let pc = cid("pc");
        for id in ["pc", "ally"] {
            w.characters.get_mut(&cid(id)).unwrap().current_room_id = Some(rid("room1"));
        }
        w.rooms.insert(rid("room1"), RoomSnapshot {
            id: rid("room1"),
            name: "Test Room".into(),
            description: String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc.clone(), cid("ally")],
            loot_ids: alloc::vec![],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        });
        let attacks = w.run_mob_reactions(&pc, &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty()); // ally is kind=player, not Mob
    }
}
```

Note: `seat_test_mob` (formations.rs:91) is `#[cfg(test)]` inside `formations::conformance` — available to `cargo test`. It seats a `CharacterKind::Mob` with `natural_attack: None` (→ default `{health, 1}` via combat.rs:158-168).

- [ ] **Step 2: Run to verify failure**

Add `pub mod submit;` to `crates/wickedways-core/src/world/mod.rs`, then:

```bash
cargo test -p wickedways-core submit
```
Expected: COMPILE ERROR — `no method named run_mob_reactions`.

- [ ] **Step 3: Implement `MobAttack` + `run_mob_reactions`**

Prepend to `crates/wickedways-core/src/world/submit.rs`:

```rust
//! Phase 2a: the ported `GameSession.execute` orchestration.
//!
//! `run_mob_reactions` — solo-GM turn driver, faithful port of
//! `packages/play-runtime/src/session.ts:148-177`.
//! (`ExecuteResult` + `World::submit` land in the next slice of this file.)
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::snapshot::CharacterKind;
use crate::world::World;

/// A single mob-on-player strike, surfaced for typed combat feedback.
/// Mirrors the TS `MobAttack` (`session.ts:22`); `amount` is an effective-stat
/// delta (f64 per sub-plan 4b's stat model).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MobAttack {
    pub name: String,
    pub stat: StatType,
    pub amount: f64,
}

impl World {
    /// Each live (non-KO) mob in the active player's current room attacks the
    /// player (the "aggro while sharing its room" rule). Returns the typed damage
    /// each dealt, derived from the player's effective-stat deltas. A mob that
    /// can't act (afflicted → `ProceduralViolation` from `attack`) simply doesn't
    /// strike; a downed player is not piled on.
    ///
    /// Faithful port of `session.ts` `runMobReactions` (:148-177):
    /// - no current room or active player KO → empty
    /// - snapshot of the occupant id list, in room order (TS `[...room.occupants]`)
    /// - skip the active character, non-`Mob`s, KO'd mobs
    /// - per stat in [Health, Sanity, Energy] order: `before - after > 0` → push
    /// - break once the player is KO
    pub fn run_mob_reactions(
        &mut self,
        active: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Vec<MobAttack> {
        const STATS: [StatType; 3] = [StatType::Health, StatType::Sanity, StatType::Energy];
        let mut attacks: Vec<MobAttack> = Vec::new();

        let Some(room_id) = self
            .characters
            .get(active)
            .and_then(|c| c.current_room_id.clone())
        else {
            return attacks;
        };
        if self.is_ko(active) {
            return attacks;
        }

        let occupant_ids: Vec<CharacterId> = self
            .rooms
            .get(&room_id)
            .map(|r| r.occupant_ids.clone())
            .unwrap_or_default();

        for occ in occupant_ids {
            if &occ == active {
                continue;
            }
            let is_mob = self
                .characters
                .get(&occ)
                .map(|c| c.kind == CharacterKind::Mob)
                .unwrap_or(false);
            if !is_mob || self.is_ko(&occ) {
                continue;
            }

            let before: [f64; 3] =
                STATS.map(|s| self.effective_stat(active, s, cat));
            // A blocked (afflicted) mob's ProceduralViolation is swallowed —
            // the mob simply doesn't strike (session.ts:165-168). All core
            // errors are ProceduralViolation, so every Err is the "skip" arm.
            if self.attack(&occ, active, cat, cues).is_err() {
                continue;
            }
            let after: [f64; 3] =
                STATS.map(|s| self.effective_stat(active, s, cat));

            let name = self
                .characters
                .get(&occ)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            for (i, stat) in STATS.iter().enumerate() {
                let dealt = before[i] - after[i];
                if dealt > 0.0 {
                    attacks.push(MobAttack { name: name.clone(), stat: *stat, amount: dealt });
                }
            }
            if self.is_ko(active) {
                break; // don't pile on a downed player
            }
        }
        attacks
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p wickedways-core submit && cargo build -p wickedways-core --no-default-features
```
Expected: 6 tests PASS; `no_std` build PASSES.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/submit.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): MobAttack + run_mob_reactions (port of GameSession.runMobReactions)"
```

---

### Task 4: `ExecuteResult` + `World::submit` + intent legality guards + `World::read_item`

**Files:**
- Modify: `crates/wickedways-core/src/world/submit.rs`

**Interfaces:**
- Consumes: `Intent`/`is_time_advancing` (Task 2), `MobAttack`/`run_mob_reactions` (Task 3), and the existing engine ops with these exact signatures — `start_turn(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>` (turn.rs:73), `next_player(&mut self, cat, cues) -> Result<(), ProceduralViolation>` (turn.rs:159), `go(&mut self, actor, dir: Direction, cat, cues)` (movement.rs:52), `take(&mut self, actor, target: &ItemId, cat, cues) -> Result<Option<LootId>, ProceduralViolation>` (items_actions.rs:57), `drop_item` (items_actions.rs:560), `use_item` (items_actions.rs:620), `equip` (items_actions.rs:288), `unequip` (items_actions.rs:434), `attack` (combat.rs:175), `active_character_id()` (turn.rs:18), `resolve_item(snap, cat)` (resolve.rs), `is_ko` (view.rs:174).
- Produces: `pub struct ExecuteResult { cues, mob_attacks: Option<Vec<MobAttack>>, error: Option<String> }`; `World::submit(&mut self, intent: Intent, cat: &Catalog, opened: &mut BTreeSet<String>) -> ExecuteResult`; `World::read_item(&mut self, actor: &CharacterId, item: &ItemId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`. Task 7's `Authority` wraps all three.

**The verbatim TS error strings ported here** (from `session.ts` `dispatch`, :179-256 — the fixtures verify them byte-for-byte):

| Intent case | Guard | Exact string |
|---|---|---|
| `open` — no such loot in room | pre-check | `There's nothing like that to open here.` |
| `take` — item in no loot container here | pre-check | `You don't see that here.` |
| `drop`/`equip`/`use` — not in inventory items | pre-check | `You aren't carrying that.` |
| `drop` — `droppable === false` | pre-check | `You can't bring yourself to part with the {name}.` |
| `unequip` — not equipped | pre-check | `That isn't equipped.` |
| `attack` — no such occupant | pre-check | `There's nothing like that to attack here.` |
| `attack` — target KO | pre-check | `The {name} is already dead.` |
| `talk` — always | dispatch | `There's no one here to talk to.` |

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `crates/wickedways-core/src/world/submit.rs` (reuses `world_with_pc_in_room`, `cid`, `rid` from Task 3):

```rust
    use alloc::collections::BTreeSet;
    use crate::world::intent::Intent;
    use crate::world::ids::{ItemId, LootId};
    use crate::world::snapshot::{ItemSnapshot, LootSnapshot};
    use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use serde_json::json;

    fn iid(s: &str) -> ItemId { ItemId(s.into()) }
    fn lid(s: &str) -> LootId { LootId(s.into()) }

    /// Catalog with one weapon "items/sword" (equippable) and one consumable
    /// "items/herb" (usable, lore) — the same descriptor shapes as command.rs tests.
    fn cat_with_items() -> Catalog {
        let mut items = BTreeMap::new();
        items.insert("items/sword".to_string(), ItemDescriptor {
            name: "Sword".into(), r#type: ItemType::Weapon, stat: StatType::Health,
            modifier: 3,
            properties: ItemProperties {
                equippable: true, equipped: false, destroyable: true,
                usable: false, droppable: None,
            },
            slot: Some(SlotKind::Hand), two_handed: None, emits_light: None,
            max_durability: Some(5), lore: None, presentation: None, key_code: None,
            consume_on_use: None, recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        });
        items.insert("items/herb".to_string(), ItemDescriptor {
            name: "Herb".into(), r#type: ItemType::Consumable, stat: StatType::Health,
            modifier: 2,
            properties: ItemProperties {
                equippable: false, equipped: false, destroyable: false,
                usable: true, droppable: None,
            },
            slot: None, two_handed: None, emits_light: None, max_durability: None,
            lore: Some("Bitter leaves.".into()), presentation: None, key_code: None,
            consume_on_use: Some(true), recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        });
        // A required quest item (droppable: false) for the drop guard.
        items.insert("items/locket".to_string(), ItemDescriptor {
            name: "Locket".into(), r#type: ItemType::Accessory, stat: StatType::Sanity,
            modifier: 0,
            properties: ItemProperties {
                equippable: false, equipped: false, destroyable: false,
                usable: false, droppable: Some(false),
            },
            slot: None, two_handed: None, emits_light: None, max_durability: None,
            lore: None, presentation: None, key_code: None, consume_on_use: None,
            recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        });
        Catalog { items, aliases: BTreeMap::new() }
    }

    /// PC in room1 holding a sword (item-sword) and a locket (item-locket);
    /// the room holds a chest (loot-1) containing an herb (item-herb).
    fn world_for_submit() -> World {
        let mut w = world_with_pc_in_room();
        let pc = cid("pc");
        for (id, key) in [("item-sword", "items/sword"), ("item-locket", "items/locket"), ("item-herb", "items/herb")] {
            w.items.insert(iid(id), ItemSnapshot::Item {
                id: iid(id), behavior_key: key.into(),
                durability: if key == "items/sword" { Some(5) } else { None },
                modifier: 0,
            });
        }
        let ch = w.characters.get_mut(&pc).unwrap();
        ch.inventory.item_ids.push(iid("item-sword"));
        ch.inventory.item_ids.push(iid("item-locket"));
        w.loot.insert(lid("loot-1"), LootSnapshot {
            id: lid("loot-1"), description: "A chest".into(), capacity: 5,
            content_ids: alloc::vec![iid("item-herb")],
        });
        w.rooms.get_mut(&rid("room1")).unwrap().loot_ids.push(lid("loot-1"));
        w
    }

    fn submit_one(w: &mut World, intent: Intent) -> (ExecuteResult, BTreeSet<String>) {
        let mut opened = BTreeSet::new();
        let r = w.submit(intent, &cat_with_items(), &mut opened);
        (r, opened)
    }

    #[test]
    fn wait_advances_the_turn_and_returns_empty_mob_attacks() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Wait);
        assert_eq!(r.error, None);
        assert_eq!(r.mob_attacks, Some(Vec::new())); // TS: mobAttacks present ([]) on success
        // single-member party: next_player wraps → round 0 → 1
        assert_eq!(w.campaign.round, 1);
    }

    #[test]
    fn equip_is_free_no_turn_wrap() {
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Equip { target_id: "item-sword".into() });
        assert_eq!(r.error, None);
        assert_eq!(w.campaign.round, 0, "free action must not advance the round");
        assert!(w.characters[&cid("pc")].equipment.values().any(|i| i == &iid("item-sword")));
    }

    #[test]
    fn open_marks_loot_revealed_without_advancing() {
        let mut w = world_for_submit();
        let (r, opened) = submit_one(&mut w, Intent::Open { target_id: "loot-1".into() });
        assert_eq!(r.error, None);
        assert!(opened.contains("loot-1"));
        assert_eq!(w.campaign.round, 0);
        assert_eq!(w.loot[&lid("loot-1")].content_ids.len(), 1, "open mutates nothing");
    }

    #[test]
    fn take_auto_opens_moves_item_and_advances() {
        let mut w = world_for_submit();
        let (r, opened) = submit_one(&mut w, Intent::Take { target_id: "item-herb".into() });
        assert_eq!(r.error, None);
        assert!(opened.contains("loot-1"), "take auto-opens the container");
        assert!(w.characters[&cid("pc")].inventory.item_ids.contains(&iid("item-herb")));
        assert_eq!(w.campaign.round, 1);
    }

    #[test]
    fn mob_reactions_run_inside_an_advancing_submit() {
        let mut w = world_for_submit();
        seat_test_mob(&mut w, "wraith", "room1");
        let (r, _) = submit_one(&mut w, Intent::Wait);
        assert_eq!(r.error, None);
        let attacks = r.mob_attacks.unwrap();
        assert_eq!(attacks.len(), 1);
        assert_eq!(attacks[0].name, "wraith");
    }

    // ── legality guards: exact TS strings, no state change ──────────────────

    #[test]
    fn error_results_use_exact_ts_strings_and_omit_mob_attacks() {
        let cases: alloc::vec::Vec<(Intent, &str)> = alloc::vec![
            (Intent::Open { target_id: "nope".into() }, "There's nothing like that to open here."),
            (Intent::Take { target_id: "nope".into() }, "You don't see that here."),
            (Intent::Drop { target_id: "nope".into() }, "You aren't carrying that."),
            (Intent::Drop { target_id: "item-locket".into() },
                "You can't bring yourself to part with the Locket."),
            (Intent::Equip { target_id: "nope".into() }, "You aren't carrying that."),
            (Intent::Use { target_id: "nope".into() }, "You aren't carrying that."),
            (Intent::Unequip { target_id: "item-sword".into() }, "That isn't equipped."),
            (Intent::Attack { target_id: "nope".into() }, "There's nothing like that to attack here."),
            (Intent::Talk { npc_id: "n1".into(), prompt: None }, "There's no one here to talk to."),
        ];
        for (intent, want) in cases {
            let mut w = world_for_submit();
            let (r, _) = submit_one(&mut w, intent.clone());
            assert_eq!(r.error.as_deref(), Some(want), "intent {intent:?}");
            assert_eq!(r.mob_attacks, None, "TS error path omits mobAttacks ({intent:?})");
        }
    }

    #[test]
    fn attack_on_ko_target_reports_already_dead() {
        let mut w = world_for_submit();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Ko, true);
        let (r, _) = submit_one(&mut w, Intent::Attack { target_id: "wraith".into() });
        assert_eq!(r.error.as_deref(), Some("The wraith is already dead."));
    }

    #[test]
    fn error_path_still_returns_cues_emitted_before_the_throw() {
        // Advancing intent: start_turn runs (mutating), then the guard throws.
        // TS returns { cues-so-far, error } and does NOT roll back (session.ts:134-138).
        let mut w = world_for_submit();
        let (r, _) = submit_one(&mut w, Intent::Take { target_id: "nope".into() });
        assert_eq!(r.error.as_deref(), Some("You don't see that here."));
        assert_eq!(w.campaign.round, 0, "next_player must NOT run after a throw");
    }

    // ── read_item ────────────────────────────────────────────────────────────

    #[test]
    fn read_item_emits_lore_as_mechanic_cue() {
        use crate::presentation::MechanicCue;
        let mut w = world_for_submit();
        // move the herb (has lore) into inventory first
        let mut opened = BTreeSet::new();
        w.submit(Intent::Take { target_id: "item-herb".into() }, &cat_with_items(), &mut opened);
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-herb"), &cat_with_items(), &mut cues).unwrap();
        assert_eq!(cues, alloc::vec![PresentationCue::Mechanic {
            cue: MechanicCue { text: Some("Bitter leaves.".into()), sound: None },
        }]);
        // free + non-consuming: still held, round unchanged by read itself
        assert!(w.characters[&cid("pc")].inventory.item_ids.contains(&iid("item-herb")));
    }

    #[test]
    fn read_item_not_held_is_a_quiet_no_op() {
        // Mirrors GameSession.read (session.ts:104-111): returns [] rather than
        // surfacing Character.read's throw.
        let mut w = world_for_submit();
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-herb"), &cat_with_items(), &mut cues).unwrap();
        assert!(cues.is_empty());
    }

    #[test]
    fn read_item_without_lore_is_silent() {
        let mut w = world_for_submit();
        let mut cues = Vec::new();
        w.read_item(&cid("pc"), &iid("item-sword"), &cat_with_items(), &mut cues).unwrap();
        assert!(cues.is_empty());
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p wickedways-core submit
```
Expected: COMPILE ERROR — `cannot find type ExecuteResult` / `no method named submit`.

- [ ] **Step 3: Implement `ExecuteResult`, `submit`, `dispatch_intent`, `read_item`**

Add to `crates/wickedways-core/src/world/submit.rs` (below `MobAttack`, inside the same file; extend the `use` block with `alloc::collections::BTreeSet`, `alloc::format`, `crate::error::ProceduralViolation`, `crate::presentation::MechanicCue`, `crate::world::ids::ItemId`, `crate::world::intent::{is_time_advancing, Intent}`, `crate::world::resolve::resolve_item`):

```rust
/// Mirrors the TS `ExecuteResult` (`session.ts:24`): `mobAttacks` is present
/// (possibly `[]`) on success and ABSENT on the error path; `error` carries the
/// `ProceduralViolation` message verbatim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub cues: Vec<PresentationCue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub mob_attacks: Option<Vec<MobAttack>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub error: Option<String>,
}

impl World {
    /// The ported `GameSession.execute` flow (`session.ts:116-140`), minus the
    /// host-side undo snapshot (undo stays host-side via `Authority::snapshot`):
    /// classify → `start_turn` → dispatch → `run_mob_reactions` → `next_player`;
    /// free actions skip the wrap. A `ProceduralViolation` anywhere is caught
    /// and returned as `ExecuteResult.error` with the cues emitted so far.
    pub fn submit(
        &mut self,
        intent: Intent,
        cat: &Catalog,
        opened: &mut BTreeSet<String>,
    ) -> ExecuteResult {
        let mut cues: Vec<PresentationCue> = Vec::new();
        let advances = is_time_advancing(&intent);
        let outcome: Result<Option<Vec<MobAttack>>, ProceduralViolation> = (|| {
            let actor = self.active_character_id()?;
            if advances {
                self.start_turn(&actor, cat, &mut cues)?;
            }
            self.dispatch_intent(&actor, intent, cat, opened, &mut cues)?;
            // Solo GM: after a time-advancing action, live mobs sharing the
            // player's room strike back. Runs before next_player so a fatal blow
            // is caught by the round's outcome check (session.ts:127-131).
            let mob_attacks = if advances {
                self.run_mob_reactions(&actor, cat, &mut cues)
            } else {
                Vec::new()
            };
            if advances {
                self.next_player(cat, &mut cues)?;
            }
            Ok(Some(mob_attacks))
        })();
        match outcome {
            Ok(mob_attacks) => ExecuteResult { cues, mob_attacks, error: None },
            Err(ProceduralViolation(msg)) => ExecuteResult {
                cues,
                mob_attacks: None, // TS error path returns { cues, error } — no mobAttacks key
                error: Some(msg),
            },
        }
    }

    /// The intent → engine-op mapping, including the intent-level legality
    /// guards that live in TS `GameSession.dispatch` (`session.ts:179-256`) but
    /// NOT in the engine's `Command` handlers. Guard strings are verbatim TS.
    fn dispatch_intent(
        &mut self,
        actor: &CharacterId,
        intent: Intent,
        cat: &Catalog,
        opened: &mut BTreeSet<String>,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        match intent {
            Intent::Move { dir } => self.go(actor, dir, cat, cues),
            Intent::Wait => Ok(()),
            Intent::Open { target_id } => {
                let room_id = self.current_room_id_of(actor)?;
                let in_room = self
                    .rooms
                    .get(&room_id)
                    .map(|r| r.loot_ids.iter().any(|l| l.0 == target_id))
                    .unwrap_or(false);
                if !in_room {
                    return Err(ProceduralViolation(
                        "There's nothing like that to open here.".into(),
                    ));
                }
                // TS also calls pc.openLootBox(loot) — a co-location assert +
                // contents peek with no mutation/cue (player-character.ts:201-204);
                // co-location holds by construction here, so only the reveal remains.
                opened.insert(target_id);
                Ok(())
            }
            Intent::Take { target_id } => {
                // TS findInLoot (session.ts:249-256): searched BEFORE the engine
                // gate/dark checks, throwing "You don't see that here.".
                let room_id = self.current_room_id_of(actor)?;
                let target = ItemId(target_id);
                let visible = self
                    .rooms
                    .get(&room_id)
                    .map(|r| {
                        r.loot_ids.iter().any(|lid| {
                            self.loot
                                .get(lid)
                                .map(|l| l.content_ids.contains(&target))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if !visible {
                    return Err(ProceduralViolation("You don't see that here.".into()));
                }
                if let Some(loot_id) = self.take(actor, &target, cat, cues)? {
                    opened.insert(loot_id.0); // auto-open (session.ts:198-201)
                }
                Ok(())
            }
            Intent::Drop { target_id } => {
                let item_id = ItemId(target_id);
                self.guard_carrying(actor, &item_id)?;
                let snap = self
                    .items
                    .get(&item_id)
                    .ok_or_else(|| ProceduralViolation("You aren't carrying that.".into()))?;
                let resolved = resolve_item(snap, cat)?;
                // Required quest items (droppable === false) can't be set down
                // (session.ts:208-211).
                if resolved.properties.droppable == Some(false) {
                    return Err(ProceduralViolation(format!(
                        "You can't bring yourself to part with the {}.",
                        resolved.name
                    )));
                }
                self.drop_item(actor, &item_id, cat, cues)
            }
            Intent::Equip { target_id } => {
                let item_id = ItemId(target_id);
                self.guard_carrying(actor, &item_id)?;
                self.equip(actor, &item_id, cat, cues)
            }
            Intent::Unequip { target_id } => {
                let item_id = ItemId(target_id);
                let equipped = self
                    .characters
                    .get(actor)
                    .map(|c| c.equipment.values().any(|i| i == &item_id))
                    .unwrap_or(false);
                if !equipped {
                    return Err(ProceduralViolation("That isn't equipped.".into()));
                }
                self.unequip(actor, &item_id, cat, cues)
            }
            Intent::Use { target_id } => {
                let item_id = ItemId(target_id);
                self.guard_carrying(actor, &item_id)?;
                self.use_item(actor, &item_id, cat, cues)
            }
            Intent::Attack { target_id } => {
                let room_id = self.current_room_id_of(actor)?;
                let target = CharacterId(target_id);
                let in_room = self
                    .rooms
                    .get(&room_id)
                    .map(|r| r.occupant_ids.contains(&target))
                    .unwrap_or(false);
                if !in_room {
                    return Err(ProceduralViolation(
                        "There's nothing like that to attack here.".into(),
                    ));
                }
                if self.is_ko(&target) {
                    let name = self
                        .characters
                        .get(&target)
                        .map(|c| c.name.clone())
                        .unwrap_or_default();
                    return Err(ProceduralViolation(format!("The {name} is already dead.")));
                }
                self.attack(actor, &target, cat, cues)
            }
            Intent::Talk { .. } => {
                // No NPCs in this campaign; dialogue is reserved for future
                // content (session.ts:242-245).
                Err(ProceduralViolation("There's no one here to talk to.".into()))
            }
        }
    }

    /// Reads a held item, emitting its lore as a `mechanic` cue. Free, ungated,
    /// non-consuming. Mirrors `GameSession.read` (session.ts:104-111) over
    /// `Character.read` (character.ts:784-792): a non-held item is a quiet no-op
    /// (the facade returned `[]` instead of surfacing the engine throw).
    pub fn read_item(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        let held = self
            .characters
            .get(actor)
            .map(|c| c.inventory.item_ids.contains(item))
            .unwrap_or(false);
        if !held {
            return Ok(());
        }
        let snap = self
            .items
            .get(item)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?;
        let resolved = resolve_item(snap, cat)?;
        if let Some(lore) = resolved.lore.clone() {
            cues.push(PresentationCue::Mechanic {
                cue: MechanicCue { text: Some(lore), sound: None },
            });
        }
        Ok(())
    }

    fn current_room_id_of(
        &self,
        actor: &CharacterId,
    ) -> Result<crate::world::ids::RoomId, ProceduralViolation> {
        // TS dispatch does `pc.currentRoom!` — a missing room is unreachable in
        // normal play; we surface it as a violation rather than a panic.
        self.characters
            .get(actor)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("active character has no current room".into()))
    }

    fn guard_carrying(
        &self,
        actor: &CharacterId,
        item: &ItemId,
    ) -> Result<(), ProceduralViolation> {
        // TS checks pc.inventory.items (NOT keys) — session.ts:206/216/228.
        let held = self
            .characters
            .get(actor)
            .map(|c| c.inventory.item_ids.contains(item))
            .unwrap_or(false);
        if held {
            Ok(())
        } else {
            Err(ProceduralViolation("You aren't carrying that.".into()))
        }
    }
}
```

Note on `resolved.lore`: `ResolvedItem.lore` is `Option<String>` (view.rs:159-166 reads `resolved.lore.is_some()`); if the field is borrowed, `.clone()` as shown.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p wickedways-core submit && cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features
```
Expected: all new tests PASS, no regression in the crate suite, `no_std` PASSES.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/submit.rs
git commit -m "feat(core): World::submit orchestration + intent legality guards + read_item"
```

---

### Task 5: ts-rs bindings for `Intent`/`MobAttack`/`ExecuteResult`

**Files:**
- Modify: `crates/wickedways-core/src/stats.rs` (the `export_typescript_bindings` test, :41-87)
- Generated: `generated/bindings/Intent.ts`, `generated/bindings/MobAttack.ts`, `generated/bindings/ExecuteResult.ts`

**Interfaces:**
- Consumes: the `#[cfg_attr(feature = "ts", derive(TS), ts(export))]` derives added in Tasks 2-4.
- Produces: checked-in generated TS types; Task 11's `intent.ts`/`session.ts` import them. `bindings:check` (`pnpm run bindings:gen && git diff --exit-code generated/bindings`) enforces no drift.

- [ ] **Step 1: Extend the export test**

In `crates/wickedways-core/src/stats.rs`, inside `fn export_typescript_bindings()` (append after the `Afflictions::export_all()` line, :86):

```rust
        // Phase 2a: the Authority boundary types
        use crate::world::intent::Intent;
        use crate::world::submit::{ExecuteResult, MobAttack};
        Intent::export_all().expect("export Intent");
        MobAttack::export_all().expect("export MobAttack");
        ExecuteResult::export_all().expect("export ExecuteResult");
```

- [ ] **Step 2: Verify `bindings:check` fails (drift detected)**

```bash
pnpm run bindings:check
```
Expected: FAIL — `git diff --exit-code generated/bindings` exits 1 (three new untracked/changed files).

- [ ] **Step 3: Generate and inspect**

```bash
pnpm run bindings:gen
cat generated/bindings/Intent.ts generated/bindings/MobAttack.ts generated/bindings/ExecuteResult.ts
```
Expected: `Intent` is a `kind`-discriminated union with `targetId`/`npcId`/`prompt?`/`dir` fields exactly mirroring `packages/play-runtime/src/intent.ts:3-13`; `MobAttack = { name: string, stat: StatType, amount: number }`; `ExecuteResult = { cues: Array<PresentationCue>, mobAttacks?: Array<MobAttack>, error?: string }`.

- [ ] **Step 4: Verify check passes and commit**

```bash
git add generated/bindings crates/wickedways-core/src/stats.rs
pnpm run bindings:check
```
Expected: PASS (clean diff).

```bash
git commit -m "feat(bindings): generate Intent, MobAttack, ExecuteResult TS types"
```

---

### Task 6: ViewModel parity — `exits`, `lockedDoors`, `status.locationName`

**Why this task exists (not in the spec's sketch):** the Rust `ViewModel` (view.rs:105-118) lacks `exits`/`lockedDoors`/`status.locationName`; the surfaces require them (see File Structure → Deviations #1). `Authority.view()` (Task 7) must emit the full shape.

**Ordering decision (document in code comments):** TS `view()` lists exits in `Map` insertion (authoring) order; Rust `room.exits` is a `BTreeMap<String, ExitId>` (alphabetical by direction key). Exit listing order is presentation-only (narrator/HUD listing), so the port **defines** the canonical order as *alphabetical by direction key* and the TS oracle adopts it with a one-line sort. This is a deliberate, spec'd ordering for the port — NOT golden-fudging: the TS oracle still generates every golden byte, and `canonical-json.ts` is untouched.

**Files:**
- Modify: `crates/wickedways-core/src/world/view.rs`
- Modify: `crates/wickedways-core/src/stats.rs` (export list)
- Modify: `packages/play-runtime/src/viewmodel.ts` (sort only)
- Modify: `conformance/fixtures/gen-helpers.ts` (`viewProjected` keeps the new fields)
- Regenerated: `conformance/fixtures/*.golden.json` + `*.start.snapshot.json` (via `fixtures:gen`)
- Generated: `generated/bindings/{ExitView,LockedDoorView,StatusView,ViewModel}.ts`

**Interfaces:**
- Consumes: `World::character_view(&self, id: &CharacterId, cat: &Catalog) -> Option<CharacterView>` (mechanics/view.rs:101, `pub(crate)` — same crate), `exit_behavior(key) -> Option<&'static dyn ExitBehavior>` + `ExitBehavior::can_pass(&self, actor: &CharacterView, state: &Value) -> bool` (exits.rs:10-29), `ExitSnapshot { endpoint_ids: [RoomId; 2], behavior_key: Option<String>, name: Option<String>, state: Value }` (snapshot.rs:58-66).
- Produces: `pub struct ExitView { dir: Direction, to_name: String }`, `pub struct LockedDoorView { name: String, dir: Direction }`, `StatusView.location_name: String`, `ViewModel.exits: Vec<ExitView>`, `ViewModel.locked_doors: Vec<LockedDoorView>` — full-shape `view()` consumed by Task 7's `Authority.view` and Task 11's surfaces.

- [ ] **Step 1: Write the failing Rust tests**

Append to the existing `tests` module in `crates/wickedways-core/src/world/view.rs` (it already builds worlds with rooms/exits at :549/:644 — follow its local helpers for room construction):

```rust
    #[test]
    fn view_lists_passable_exits_alphabetically_with_destination_names() {
        use crate::world::direction::Direction;
        use crate::world::ids::ExitId;
        use crate::world::snapshot::ExitSnapshot;
        // Build on an existing two-room test world from this module: a room
        // "room1" (active PC inside) and "room2" named "Crypt". Wire two
        // behavior-free exits: south + north (insertion order reversed to prove
        // the BTreeMap ordering, not authoring order, is emitted).
        let mut w = world_for_view(); // this module's existing world builder
        w.exits.insert(ExitId("e1".into()), ExitSnapshot {
            id: ExitId("e1".into()),
            endpoint_ids: [rid("room1"), rid("room2")],
            behavior_key: None,
            name: None,
            state: serde_json::Value::Null,
        });
        let room = w.rooms.get_mut(&rid("room1")).unwrap();
        room.exits.insert("south".into(), ExitId("e1".into()));
        room.exits.insert("north".into(), ExitId("e1".into()));
        let vm = w.view(&Catalog::default(), &BTreeSet::new()).unwrap();
        assert_eq!(vm.locked_doors, alloc::vec![]);
        assert_eq!(
            vm.exits,
            alloc::vec![
                ExitView { dir: Direction::North, to_name: "Crypt".into() },
                ExitView { dir: Direction::South, to_name: "Crypt".into() },
            ],
            "alphabetical by direction key"
        );
        assert_eq!(vm.status.location_name, vm.room.name);
    }

    #[test]
    fn keyed_door_without_key_lists_as_locked_door_with_name_fallback() {
        use crate::world::direction::Direction;
        use crate::world::ids::ExitId;
        use crate::world::snapshot::ExitSnapshot;
        let mut w = world_for_view();
        // conformance:keyed-door is registered under cfg(test) (exits.rs:23-27);
        // locked state + no key on the PC → can_pass false.
        w.exits.insert(ExitId("door".into()), ExitSnapshot {
            id: ExitId("door".into()),
            endpoint_ids: [rid("room1"), rid("room2")],
            behavior_key: Some("conformance:keyed-door".into()),
            name: None, // → "door" fallback (viewmodel.ts:131 `exit.name ?? "door"`)
            state: serde_json::json!({ "unlocked": false }),
        });
        w.rooms.get_mut(&rid("room1")).unwrap()
            .exits.insert("north".into(), ExitId("door".into()));
        let vm = w.view(&Catalog::default(), &BTreeSet::new()).unwrap();
        assert_eq!(vm.exits, alloc::vec![]);
        assert_eq!(vm.locked_doors, alloc::vec![
            LockedDoorView { name: "door".into(), dir: Direction::North },
        ]);
    }
```

If this module has no reusable two-room builder named `world_for_view`, add one modeled on the existing test worlds at view.rs:540-560 (a `world_with_party(&["pc"], 10)` + `room1` "Test Room" with the PC + `room2` "Crypt", both lit) — do NOT invent new snapshot fields; copy the `RoomSnapshot` literal shape used at view.rs:549.

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p wickedways-core view
```
Expected: COMPILE ERROR — `ExitView` not found / no `exits` field on `ViewModel`.

- [ ] **Step 3: Widen the Rust ViewModel**

In `crates/wickedways-core/src/world/view.rs`:

Add the two structs (next to `ThinRoom`):

```rust
/// A passable exit as the surface lists it. Mirrors `ExitView` (viewmodel.ts:27).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ExitView {
    pub dir: crate::world::direction::Direction,
    pub to_name: String,
}

/// An impassable (locked) exit. Mirrors `LockedDoorView` (viewmodel.ts:28).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct LockedDoorView {
    pub name: String,
    pub dir: crate::world::direction::Direction,
}
```

Widen `StatusView` (add as the FIRST field, mirroring the TS object literal at viewmodel.ts:157-163):

```rust
pub struct StatusView {
    pub location_name: String,
    pub turn: i64,
    pub max_turns: i64,
    pub health: f64,
    pub sanity: f64,
}
```

Widen `ViewModel` (fields after `room`, mirroring viewmodel.ts:30-41 order):

```rust
pub struct ViewModel {
    pub room: ThinRoom,
    pub exits: Vec<ExitView>,
    pub locked_doors: Vec<LockedDoorView>,
    pub occupants: Vec<ScopeEntity>,
    pub loot: Vec<LootView>,
    pub inventory: Inventory,
    pub scope: Vec<ScopeEntity>,
    pub status: StatusView,
    pub outcome: CampaignOutcome,
    pub finished: bool,
}
```

In `World::view` (view.rs:204), after `is_lit` is computed, build the classification (canonical order = `BTreeMap` iteration = alphabetical by direction key):

```rust
        // ── exits / lockedDoors (Phase 2 parity) ───────────────────────────
        // Canonical order: alphabetical by direction key (BTreeMap iteration);
        // the TS oracle sorts identically (viewmodel.ts, Phase-2 ordering decision).
        let actor_view = self
            .character_view(&active_id, cat)
            .ok_or_else(|| ProceduralViolation("active character not found".into()))?;
        let mut exits: Vec<ExitView> = Vec::new();
        let mut locked_doors: Vec<LockedDoorView> = Vec::new();
        for (dir_key, exit_id) in &room_snap.exits {
            let exit = self
                .exits
                .get(exit_id)
                .ok_or_else(|| ProceduralViolation("exit missing".into()))?;
            let dir: crate::world::direction::Direction =
                serde_json::from_value(serde_json::Value::String(dir_key.clone()))
                    .map_err(|_| ProceduralViolation(format!("unknown direction key '{dir_key}'")))?;
            let passable = match &exit.behavior_key {
                None => true,
                Some(key) => {
                    let behavior = crate::world::exits::exit_behavior(key).ok_or_else(|| {
                        ProceduralViolation(format!("Exit behavior '{key}' is not registered."))
                    })?;
                    behavior.can_pass(&actor_view, &exit.state)
                }
            };
            if passable {
                let a = exit.endpoint_ids[0].clone();
                let b = exit.endpoint_ids[1].clone();
                let dest = if a == room_id { b } else { a };
                let to_name = self.rooms.get(&dest).map(|r| r.name.clone()).unwrap_or_default();
                exits.push(ExitView { dir, to_name });
            } else {
                locked_doors.push(LockedDoorView {
                    name: exit.name.clone().unwrap_or_else(|| String::from("door")),
                    dir,
                });
            }
        }
```

Thread the new fields into the returned `ViewModel` literal and set `location_name` in the `StatusView` literal to the room name the TS uses (`locationName: roomName` — viewmodel.ts:158; in Rust that's `room_snap.name.clone()`).

Fix any existing `view.rs`/other-module tests that construct `ViewModel`/`StatusView` literals — add the new fields (`exits: alloc::vec![]`, `locked_doors: alloc::vec![]`, `location_name: <room name>`).

- [ ] **Step 4: Run the Rust suite**

```bash
cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features
```
Expected: PASS (including the two new tests).

- [ ] **Step 5: Adopt the canonical exit order in the TS oracle**

In `packages/play-runtime/src/viewmodel.ts` replace lines 125-131 with:

```ts
  // Canonical presentation order (Phase-2 port decision): alphabetical by
  // direction key — matches the Rust core's BTreeMap iteration so the
  // differential gate compares exits order-stably. Listing order is
  // presentation-only; classification is unchanged.
  const exitEntries = [...room.exits.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const exits: ExitView[] = exitEntries
    .filter(([, exit]) => exit.canPass(pc))
    .map(([dir, exit]) => ({ dir, toName: exit.otherSide(room).name }));

  const lockedDoors: LockedDoorView[] = exitEntries
    .filter(([, exit]) => !exit.canPass(pc))
    .map(([dir, exit]) => ({ name: exit.name ?? "door", dir }));
```

Run: `pnpm vitest run packages/play-runtime/src/viewmodel.test.ts` — Expected: PASS (update any test that asserted authoring-order exits to the sorted order if one exists).

- [ ] **Step 6: Stop projecting the new fields away in the golden generators**

In `conformance/fixtures/gen-helpers.ts`, replace `viewProjected` (:23-43) with:

```ts
/**
 * Project the full TS ViewModel to the exact Rust ViewModel subset for goldens.
 * Phase 2: `exits`, `lockedDoors`, and `status.locationName` are now emitted by
 * the Rust view and are DIFFED; only `room.image` (presentation, never
 * serialized — host-overlay concern) is still dropped.
 */
export function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]> = {},
  opened: ReadonlySet<string> = new Set(),
) {
  const full = view(campaign, aliases, opened);
  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  return {
    room: roomRest,
    exits: full.exits,
    lockedDoors: full.lockedDoors,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: full.status,
    outcome: full.outcome,
    finished: full.finished,
  };
}
```

- [ ] **Step 7: Regenerate goldens; run the gate to verify the differential**

```bash
pnpm run fixtures:gen && pnpm run test:conformance
```
Expected: generators rewrite the committed goldens (now carrying `exits`/`lockedDoors`/`locationName`); the replay suites PASS — this is the first differential coverage of exit classification through the view. If a suite FAILS, the divergence is in the Rust classification — fix `view.rs` (never the goldens/comparator).

```bash
pnpm run fixtures:stable
```
Expected: PASS (regeneration is idempotent).

- [ ] **Step 8: Export the new bindings**

Append to `export_typescript_bindings` in `crates/wickedways-core/src/stats.rs` (next to the existing `ViewModel` exports, :76-82):

```rust
        use crate::world::view::{ExitView, LockedDoorView};
        ExitView::export_all().expect("export ExitView");
        LockedDoorView::export_all().expect("export LockedDoorView");
```

```bash
pnpm run bindings:gen && git add generated/bindings && pnpm run bindings:check
```
Expected: PASS (`ExitView.ts`, `LockedDoorView.ts` new; `StatusView.ts`, `ViewModel.ts` updated).

- [ ] **Step 9: Commit**

```bash
git add crates/wickedways-core/src/world/view.rs crates/wickedways-core/src/stats.rs \
  packages/play-runtime/src/viewmodel.ts conformance/fixtures/gen-helpers.ts \
  conformance/fixtures generated/bindings
git commit -m "feat(core): ViewModel parity — exits, lockedDoors, locationName (canonical direction order)"
```

---

### Task 7: WASM `Authority` handle

**Files:**
- Create: `crates/wickedways-wasm/src/authority.rs`
- Create: `crates/wickedways-wasm/tests/authority.rs`
- Modify: `crates/wickedways-wasm/src/lib.rs` (`mod authority; pub use authority::Authority;`)
- Modify: `scripts/assert-no-conformance.mjs` (require `Authority` in the default build)

**Interfaces:**
- Consumes: `World::{from_snapshot, to_snapshot, seed_rng, validate_mechanics, begin_campaign, submit, run_mob_reactions (via submit), read_item, view, active_character_id}`, `Intent`, `ExecuteResult`, `Catalog`, `CampaignSnapshot`, `PresentationCue`, `CampaignOutcome`.
- Produces: `#[wasm_bindgen] pub struct Authority` with `constructor(genesis_json, catalog_json, seed)`, `takeStartupCues()`, `submit(intent_json)`, `view()`, `read(item_id)`, `snapshot()`, `restore(snapshot_json)`, getters `finished`/`outcome` — all JSON strings. Compiled in the **default** build (and the conformance build). Tasks 8/9's replay drivers and Task 11's `GameSession` consume it.

- [ ] **Step 1: Write the failing native smoke test**

`#[wasm_bindgen]` types compile natively (the crate is also `rlib`); `JsValue` is only constructed on error paths (lazy `map_err`), so happy-path assertions run under plain `cargo test`. Create `crates/wickedways-wasm/tests/authority.rs`:

```rust
//! Native happy-path smoke test of the Authority handle. Error paths return
//! Result<_, JsValue> and are only exercised in the wasm/conformance harness
//! (JsValue cannot be materialized off-wasm).
use wickedways_wasm::Authority;

/// Minimal PRE-begin genesis (started:false, round 0) — the mod.rs sample world
/// (crates/wickedways-core/src/world/mod.rs:142-156) with started set false.
fn genesis() -> &'static str {
    r#"{ "schemaVersion":6, "campaign":{ "id":"camp1","title":"HH","maxRounds":20,"round":0,
    "started":false,"outcome":"ongoing","winConditions":[],"loseConditions":[],
    "activeCharacterIndex":0,"partyIds":["c1"],"actedThisRound":[],"gmId":null,"materials":{},
    "claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],"actionSounds":{},
    "encounterTable":{"baseChance":0,"visited":[],"formations":[]},"chatPolicy":{},"avPolicy":{},
    "mechanics":[]}, "rooms":[{"id":"r1","name":"F","description":"d","exits":{},"dark":false,
    "spawnModifier":0,"occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],"lightSourceIds":[],
    "scenes":[]}], "exits":[], "characters":[{"kind":"player","id":"c1","name":"H",
    "stats":{"energy":5,"sanity":7,"health":10},"actionsPerRound":2,"actionsThisRound":0,
    "currentRoomId":"r1","inventory":{"slots":6,"itemIds":[],"keyIds":[]},"equipment":{},
    "history":[],"archetypeImmunities":[],"afflictions":{"active":{},"turnsActive":{},
    "shakenOff":[],"immunity":{}}}], "items":[],"loot":[],"materialCaches":[],"codex":[] }"#
}

const CATALOG: &str = r#"{ "items": {}, "aliases": {} }"#;

#[test]
fn boot_submit_snapshot_restore_roundtrip() {
    let mut auth = Authority::new(genesis(), CATALOG, 0x7e57).expect("boot");
    // core-begins: started flipped, no mechanics → empty startup cues
    let startup = auth.take_startup_cues().expect("startup");
    assert_eq!(startup, "[]");
    assert!(!auth.finished());
    assert_eq!(auth.outcome(), "ongoing");

    // wait advances the single-member party → round 1
    let out = auth.submit(r#"{ "kind": "wait" }"#).expect("submit");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["mobAttacks"], serde_json::json!([]));
    assert!(parsed.get("error").is_none());

    let snap_at_1 = auth.snapshot().expect("snapshot");
    let v: serde_json::Value = serde_json::from_str(&snap_at_1).unwrap();
    assert_eq!(v["campaign"]["round"], serde_json::json!(1));
    assert_eq!(v["campaign"]["started"], serde_json::json!(true));

    // restore rehydrates in place
    auth.submit(r#"{ "kind": "wait" }"#).expect("submit 2"); // round 2
    auth.restore(&snap_at_1).expect("restore");
    let back: serde_json::Value =
        serde_json::from_str(&auth.snapshot().expect("snapshot 2")).unwrap();
    assert_eq!(back["campaign"]["round"], serde_json::json!(1));

    // view is the full widened shape
    let vm: serde_json::Value = serde_json::from_str(&auth.view().expect("view")).unwrap();
    assert_eq!(vm["room"]["name"], serde_json::json!("F"));
    assert!(vm["status"]["locationName"].is_string());
    assert!(vm["exits"].is_array());

    // read of an unheld id: quiet no-op
    assert_eq!(auth.read("nope").expect("read"), "[]");
}

#[test]
fn talk_returns_error_result_not_a_throw() {
    let mut auth = Authority::new(genesis(), CATALOG, 1).expect("boot");
    let out = auth.submit(r#"{ "kind": "talk", "npcId": "n1" }"#).expect("submit");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["error"], serde_json::json!("There's no one here to talk to."));
    assert!(parsed.get("mobAttacks").is_none());
}
```

Add `serde_json` to `[dev-dependencies]` in `crates/wickedways-wasm/Cargo.toml` if `cargo test -p wickedways-wasm` reports it missing (it is already a regular dependency, so no change should be needed).

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p wickedways-wasm --test authority
```
Expected: COMPILE ERROR — `Authority` not found.

- [ ] **Step 3: Implement the handle**

Create `crates/wickedways-wasm/src/authority.rs`:

```rust
//! The stateful single-player WASM handle (Phase 2a). All game state lives
//! inside; only JSON strings cross the seam (master-design invariant 4).
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;
use wickedways_core::presentation::{CampaignOutcome, PresentationCue};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::ItemId;
use wickedways_core::world::intent::Intent;
use wickedways_core::{CampaignSnapshot, World};

fn js_err<E: core::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
pub struct Authority {
    world: World,
    catalog: Catalog,
    /// Loot containers revealed this session (moved here from GameSession).
    opened: BTreeSet<String>,
    /// Cues emitted during begin_campaign (the round-0 onRoundStart readout).
    startup: Vec<PresentationCue>,
}

#[wasm_bindgen]
impl Authority {
    /// `genesis_json` = a PRE-begin CampaignSnapshot (assembled + PC placed,
    /// not yet begun). Runs: from_snapshot → validate_mechanics → seed_rng(seed)
    /// → begin_campaign, buffering the startup cues.
    #[wasm_bindgen(constructor)]
    pub fn new(genesis_json: &str, catalog_json: &str, seed: u32) -> Result<Authority, JsValue> {
        let snap: CampaignSnapshot = serde_json::from_str(genesis_json).map_err(js_err)?;
        let catalog: Catalog = serde_json::from_str(catalog_json).map_err(js_err)?;
        let mut world = World::from_snapshot(snap);
        // NOTE (post-DSL reconciliation): validate_mechanics now takes &Catalog
        // (it resolves scripted behaviors from catalog.behaviors, not just the
        // native registry). Pass the parsed catalog.
        world.validate_mechanics(&catalog).map_err(|e| JsValue::from_str(&e.0))?;
        world.seed_rng(seed);
        let mut startup: Vec<PresentationCue> = Vec::new();
        world
            .begin_campaign(&catalog, &mut startup)
            .map_err(|e| JsValue::from_str(&e.0))?;
        Ok(Authority { world, catalog, opened: BTreeSet::new(), startup })
    }

    /// Opening cues emitted during begin_campaign; returns and clears the buffer
    /// (PresentationCue[] JSON). Mirrors GameSession.takeStartupCues.
    #[wasm_bindgen(js_name = takeStartupCues)]
    pub fn take_startup_cues(&mut self) -> Result<String, JsValue> {
        let out = serde_json::to_string(&self.startup).map_err(js_err)?;
        self.startup.clear();
        Ok(out)
    }

    /// The full ported execute() flow. Returns ExecuteResult JSON
    /// { cues, mobAttacks?, error? }.
    pub fn submit(&mut self, intent_json: &str) -> Result<String, JsValue> {
        // TS execute() reset the shared cue buffer, discarding untaken startup
        // cues on the first action (session.ts:117) — mirror that.
        self.startup.clear();
        let intent: Intent = serde_json::from_str(intent_json).map_err(js_err)?;
        let result = self.world.submit(intent, &self.catalog, &mut self.opened);
        serde_json::to_string(&result).map_err(js_err)
    }

    /// The widened ViewModel JSON.
    pub fn view(&self) -> Result<String, JsValue> {
        let vm = self
            .world
            .view(&self.catalog, &self.opened)
            .map_err(|e| JsValue::from_str(&e.0))?;
        serde_json::to_string(&vm).map_err(js_err)
    }

    /// Free, non-time-advancing read of a held item's lore.
    /// Returns PresentationCue[] JSON (empty when not held / no lore).
    pub fn read(&mut self, item_id: &str) -> Result<String, JsValue> {
        let actor = self
            .world
            .active_character_id()
            .map_err(|e| JsValue::from_str(&e.0))?;
        let mut cues: Vec<PresentationCue> = Vec::new();
        self.world
            .read_item(&actor, &ItemId(item_id.into()), &self.catalog, &mut cues)
            .map_err(|e| JsValue::from_str(&e.0))?;
        serde_json::to_string(&cues).map_err(js_err)
    }

    /// CampaignSnapshot JSON of the current world state.
    pub fn snapshot(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.world.to_snapshot()).map_err(js_err)
    }

    /// Rehydrate in place from a CampaignSnapshot JSON. The rng stream
    /// CONTINUES across restore (mirrors the TS opts.rng closure surviving
    /// deserializeCampaign); the opened set clears (GameSession.loadSnapshot).
    pub fn restore(&mut self, snapshot_json: &str) -> Result<(), JsValue> {
        let snap: CampaignSnapshot = serde_json::from_str(snapshot_json).map_err(js_err)?;
        let rng = self.world.rng.clone();
        let mut world = World::from_snapshot(snap);
        // NOTE (post-DSL reconciliation): validate_mechanics takes &Catalog; the
        // session's catalog is held on self.
        world.validate_mechanics(&self.catalog).map_err(|e| JsValue::from_str(&e.0))?;
        world.rng = rng;
        self.world = world;
        self.opened.clear();
        Ok(())
    }

    #[wasm_bindgen(getter)]
    pub fn finished(&self) -> bool {
        self.world.campaign.outcome != CampaignOutcome::Ongoing
    }

    #[wasm_bindgen(getter)]
    pub fn outcome(&self) -> String {
        match serde_json::to_value(self.world.campaign.outcome) {
            Ok(serde_json::Value::String(s)) => s,
            _ => String::from("ongoing"),
        }
    }
}
```

In `crates/wickedways-wasm/src/lib.rs` add at the top:

```rust
mod authority;
pub use authority::Authority;
```

If `wickedways_core::presentation` / `world::intent` / `world::ids` are not re-exported at those paths, check `crates/wickedways-core/src/lib.rs` for the actual public paths (e.g. `wickedways_core::PresentationCue`) and adjust the `use` lines — do not add new re-exports unless a path is genuinely private.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p wickedways-wasm --test authority && cargo test --workspace
```
Expected: 2 tests PASS; no workspace regression.

- [ ] **Step 5: Extend the purity check and verify both builds**

Append to `scripts/assert-no-conformance.mjs` (before the final `console.log`):

```js
if (!js.includes("class Authority")) {
  console.error("FAIL: Authority class missing from the default build");
  process.exit(1);
}
```

```bash
pnpm run wasm:build && node scripts/assert-no-conformance.mjs
node -e "const w=require('./crates/wickedways-wasm/pkg-node/wickedways_wasm.js'); const a=new w.Authority(JSON.stringify({schemaVersion:6,campaign:{id:'c',title:'t',maxRounds:20,round:0,started:false,outcome:'ongoing',winConditions:[],loseConditions:[],activeCharacterIndex:0,partyIds:['c1'],actedThisRound:[],gmId:null,materials:{},claims:[],encountered:[],knownRecipes:[],archetypes:[],actionSounds:{},encounterTable:{baseChance:0,visited:[],formations:[]},chatPolicy:{},avPolicy:{},mechanics:[]},rooms:[{id:'r1',name:'F',description:'d',exits:{},dark:false,spawnModifier:0,occupantIds:['c1'],lootIds:[],materialCacheIds:[],lightSourceIds:[],scenes:[]}],exits:[],characters:[{kind:'player',id:'c1',name:'H',stats:{energy:5,sanity:7,health:10},actionsPerRound:2,actionsThisRound:0,currentRoomId:'r1',inventory:{slots:6,itemIds:[],keyIds:[]},equipment:{},history:[],archetypeImmunities:[],afflictions:{active:{},turnsActive:{},shakenOff:[],immunity:{}}}],items:[],loot:[],materialCaches:[],codex:[]}), JSON.stringify({items:{},aliases:{}}), 7); console.log(a.takeStartupCues(), JSON.parse(a.submit(JSON.stringify({kind:'wait'}))).mobAttacks)"
```
Expected: `OK: default build exposes no conformance symbols`, then `[] []` — the handle works over real WASM in Node.

```bash
pnpm run wasm:build:conformance
```
Expected: PASS (Authority also present in the gate build).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-wasm/src/authority.rs crates/wickedways-wasm/src/lib.rs \
  crates/wickedways-wasm/tests/authority.rs scripts/assert-no-conformance.mjs
git commit -m "feat(wasm): stateful Authority handle (boot/submit/view/read/snapshot/restore)"
```

---

### Task 8: Facade differential harness + first fixtures (mob combat, free-vs-advancing)

**Oracle strategy (see Deviations #3):** the oracle is a **frozen copy** of today's `GameSession` orchestration + `view()`, living in `conformance/fixtures/`. It drives `src/lib` directly (intact until Phase 3), so goldens stay regenerable after the Task-11 cutover. Every facade fixture compares, per step: `{result, snapshot, view}` — plus the startup-cue buffer once at boot.

**Files:**
- Create: `conformance/fixtures/oracle-view.ts`
- Create: `conformance/fixtures/oracle-session.ts`
- Create: `conformance/fixtures/facade-gen.ts`
- Create: `conformance/facade-replay.ts`
- Create: `conformance/fixtures/facade-mob-combat.gen.test.ts`, `conformance/facade-mob-combat.test.ts`
- Create: `conformance/fixtures/facade-free-vs-advancing.gen.test.ts`, `conformance/facade-free-vs-advancing.test.ts`
- Modify: `conformance/fixtures/gen-helpers.ts` (import `view` from the frozen copy)
- Modify: `conformance/fixtures/vitest.config.ts` (register the 2 new generators)

**Interfaces:**
- Consumes: `Authority` (Task 7) from the conformance build at `../crates/wickedways-wasm/pkg/wickedways_wasm.js`; `canonicalize` (`conformance/canonical-json.ts`); `mulberry32` (`conformance/seeded-rng.ts`); `structuralClone`/`viewProjected` (`gen-helpers.ts`); TS engine authoring (`authorTemplate`, `assemble`, `PlayerCharacter`, `serializeCampaign`, `deserializeCampaign`).
- Produces: `OracleSession` (boot/execute/read/undo/snapshot/view + `genesis`/`startupCues`), `FacadeOp` stream driver `runFacadeGolden`, and `replayFacade(name)` used by every `facade-*.test.ts` here and in Task 9. Golden file shape per fixture `<name>`: `<name>.genesis.json`, `<name>.catalog.json`, `<name>.golden.json` = `{ seed, startupCues, ops, steps: [{ op, result, snapshot, view }] }`.

- [ ] **Step 1: Freeze the oracle view**

Create `conformance/fixtures/oracle-view.ts`: copy the ENTIRE current `packages/play-runtime/src/viewmodel.ts` (post-Task-6, i.e. including the alphabetical exit sort) verbatim, then add this header comment:

```ts
/**
 * FROZEN ORACLE COPY of packages/play-runtime/src/viewmodel.ts (Phase-2 cutover).
 * The live play-runtime view() is replaced by the Rust core in the cutover; this
 * copy keeps the TS oracle regenerable (it drives src/lib, which survives until
 * Phase 3). Byte-identical to the pre-cutover implementation — do not "improve".
 */
```

Update `conformance/fixtures/gen-helpers.ts` line 2 to import from the frozen copy:

```ts
import { view } from "./oracle-view.ts";
```

Verify nothing changed: `pnpm run fixtures:gen && pnpm run fixtures:stable` — Expected: PASS with **zero** golden diffs (the copy is byte-identical in behavior).

- [ ] **Step 2: Freeze the oracle session**

Create `conformance/fixtures/oracle-session.ts`. The `execute`/`runMobReactions`/`dispatch`/`findInLoot`/`read`/`undo` bodies are **verbatim copies from `packages/play-runtime/src/session.ts`** (:116-140, :148-177, :179-247, :249-256, :104-111, :270-281) — cut and paste, adjusting only `this.opts.*`/import paths as shown. Boot differs deliberately: it serializes the **pre-begin genesis** and assigns a **deterministic PC id** (goldens must be regeneration-stable; `GameSession.boot` leaves the uuid default — id VALUES are data that flow identically through both engines, so this doesn't weaken the differential):

```ts
/**
 * FROZEN ORACLE COPY of the pre-cutover GameSession orchestration
 * (packages/play-runtime/src/session.ts). The facade differential fixtures use
 * this as the TS oracle; the live GameSession becomes the Rust replica at the
 * cutover. Method bodies are verbatim; boot() additionally captures the
 * PRE-begin genesis (what Authority::new consumes) and pins a deterministic
 * PC id ("player:<name>", the mob-defeat.gen.test.ts convention).
 */
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { ProceduralViolation } from "wickedways/lib/util";
import { Status } from "wickedways/lib/status";
import { Mob } from "wickedways/lib/character/mob";
import { StatType } from "wickedways/lib/character/stats";
import type { Campaign } from "wickedways/lib/campaign";
import type { CharacterId } from "wickedways/lib/character/character";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { ILoot } from "wickedways/lib/loot";
import type { IItem } from "wickedways/lib/inventory";
import type { Direction } from "wickedways/lib/room";
import { view } from "./oracle-view.ts";

export interface MobAttack { name: string; stat: StatType; amount: number; }
export interface ExecuteResult { cues: PresentationCue[]; error?: string; mobAttacks?: MobAttack[]; }
export type Intent =
  | { kind: "move"; dir: Direction }
  | { kind: "take"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string }
  | { kind: "attack"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "talk"; npcId: string; prompt?: string }
  | { kind: "wait" };
const TIME_ADVANCING = new Set(["move", "take", "drop", "use", "attack", "wait", "talk"]);
export const isTimeAdvancing = (i: Intent): boolean => TIME_ADVANCING.has(i.kind);

export interface OracleArgs {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  /** SINGLE shared seeded closure — also authored into the template's rng. */
  rng: () => number;
}

export class OracleSession {
  campaign!: Campaign;
  genesis!: CampaignSnapshot;          // PRE-begin snapshot (Authority::new input)
  startupCues: PresentationCue[] = []; // captured at boot, before any op
  readonly opened = new Set<string>();
  private readonly cueBuffer: PresentationCue[] = [];
  private undoSnapshot: CampaignSnapshot | null = null;

  constructor(private readonly opts: OracleArgs) {
    const { campaign, rooms } = assemble(opts.builder.description, opts.builder.registry);
    this.campaign = campaign;
    const pc = new PlayerCharacter({ campaign, name: opts.playerName, rng: opts.rng });
    pc.id = `player:${opts.playerName}` as CharacterId; // deterministic (regen-stable goldens)
    pc.joinCampaign();
    if (opts.archetype !== undefined) pc.selectArchetype(opts.archetype as ArchetypeId);
    pc.move(rooms.get(opts.builder.description.startRoom!)!);
    campaign.gm = pc;
    // PRE-begin genesis — exactly what GameSession will hand Authority::new.
    this.genesis = serializeCampaign(campaign);
    campaign.onCue((cue) => this.cueBuffer.push(cue));
    campaign.beginCampaign();
    this.startupCues = [...this.cueBuffer];
    this.cueBuffer.length = 0;
  }

  // execute(intent), runMobReactions(), dispatch(intent), findInLoot(itemId):
  // VERBATIM from packages/play-runtime/src/session.ts:116-256 (replace
  // `this.#campaign` with `this.campaign`; keep every string and branch).
  // COPY NOW: this task runs while session.ts is still the pre-cutover
  // TS-backed implementation; Task 11 replaces that file, so the copy in this
  // module is the permanent oracle from then on.

  read(itemId: string): PresentationCue[] {
    // VERBATIM from session.ts:104-111.
    const pc = this.campaign.activeCharacter;
    const item = pc.inventory.items.find((i) => i.id === itemId);
    if (!item) return [];
    this.cueBuffer.length = 0;
    pc.read(item);
    return [...this.cueBuffer];
  }

  undo(): boolean {
    // VERBATIM semantics from session.ts:270-281.
    if (!this.undoSnapshot) return false;
    this.loadSnapshot(this.undoSnapshot);
    this.undoSnapshot = null;
    return true;
  }

  snapshot(): CampaignSnapshot { return serializeCampaign(this.campaign); }
  view() { return view(this.campaign, this.opts.aliases, this.opened); }

  private loadSnapshot(snapshot: CampaignSnapshot): void {
    // VERBATIM from session.ts:277-281 — same rng closure continues its stream
    // (mirrors Authority::restore keeping the advancing Rng).
    this.campaign = deserializeCampaign(snapshot, { registry: this.opts.registry, rng: this.opts.rng });
    this.campaign.onCue((cue) => this.cueBuffer.push(cue));
    this.opened.clear();
  }
}
```

(When pasting `execute`, keep the `pre = advances ? serializeCampaign(...)` undo stash and the `this.undoSnapshot = pre` success-only assignment — the undo fixture differentials depend on them.)

- [ ] **Step 3: The shared generator driver**

Create `conformance/fixtures/facade-gen.ts`:

```ts
/**
 * Shared facade-golden driver: runs a FacadeOp stream against the OracleSession
 * and captures per-step { op, result, snapshot, view }. The projected view drops
 * only room.image (never emitted by the Rust core — host overlay concern);
 * fixture campaigns carry no presentation assets, so everything else diffs 1:1.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { structuralClone } from "./gen-helpers.ts";
import type { Intent, OracleSession } from "./oracle-session.ts";

export type FacadeOp =
  | { kind: "submit"; intent: Intent }
  | { kind: "read"; itemId: string }
  | { kind: "undo" };

export function facadeViewProjected(oracle: OracleSession) {
  const full = oracle.view();
  const { image: _img, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  return { ...full, room: roomRest };
}

export function runFacadeGolden(oracle: OracleSession, ops: FacadeOp[]) {
  return ops.map((op) => {
    let result: unknown;
    if (op.kind === "submit") result = oracle.execute(op.intent);
    else if (op.kind === "read") result = oracle.read(op.itemId);
    else result = { ok: oracle.undo() };
    return {
      op,
      result: structuralClone(result),
      snapshot: structuralClone(serializeCampaign(oracle.campaign)),
      view: structuralClone(facadeViewProjected(oracle)),
    };
  });
}

export interface FacadeStep {
  op: FacadeOp;
  result: unknown;
  snapshot: unknown;
  view: unknown;
}

/** Writes the three fixture files and RETURNS the steps so generators can
 *  assert their coverage bars (mirrors the victory-won generator style). */
export function writeFacadeFixture(
  here: string,
  name: string,
  seed: number,
  oracle: OracleSession,
  catalog: unknown,
  ops: FacadeOp[],
): FacadeStep[] {
  const startupCues = structuralClone(oracle.startupCues);
  const genesis = structuralClone(oracle.genesis);
  const steps = runFacadeGolden(oracle, ops);
  writeFileSync(join(here, `${name}.genesis.json`), JSON.stringify(genesis, null, 2) + "\n");
  writeFileSync(join(here, `${name}.catalog.json`), JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(
    join(here, `${name}.golden.json`),
    JSON.stringify({ seed, startupCues, ops, steps }, null, 2) + "\n",
  );
  return steps;
}
```

- [ ] **Step 4: The shared replay driver**

Create `conformance/facade-replay.ts`:

```ts
/**
 * Authority-driven replay: boots `new Authority(genesis, catalog, seed)`,
 * compares startup cues, then replays the op stream comparing
 * { result, snapshot, view } per step (canonicalized). Undo is mirrored
 * host-side exactly as the cutover GameSession does it: stash snapshot()
 * before a successful advancing submit; undo = restore(stash).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { expect } from "vitest";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const TIME_ADVANCING = new Set(["move", "take", "drop", "use", "attack", "wait", "talk"]);

interface GoldenStep { op: { kind: string; intent?: { kind: string }; itemId?: string }; result: unknown; snapshot: unknown; view: unknown; }
interface Golden { seed: number; startupCues: unknown[]; ops: unknown[]; steps: GoldenStep[]; }

export function replayFacade(name: string): void {
  const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
    Authority: new (genesis: string, catalog: string, seed: number) => {
      takeStartupCues(): string;
      submit(intent: string): string;
      read(itemId: string): string;
      snapshot(): string;
      restore(snapshot: string): void;
      view(): string;
    };
  };
  const genesis = readFileSync(join(here, `fixtures/${name}.genesis.json`), "utf8");
  const catalog = readFileSync(join(here, `fixtures/${name}.catalog.json`), "utf8");
  const golden = JSON.parse(readFileSync(join(here, `fixtures/${name}.golden.json`), "utf8")) as Golden;

  const auth = new wasm.Authority(genesis, catalog, golden.seed);
  expect(canonicalize(JSON.parse(auth.takeStartupCues())), "startup cues").toEqual(
    canonicalize(golden.startupCues),
  );

  let undoStash: string | null = null;
  golden.steps.forEach((want, i) => {
    let got: unknown;
    if (want.op.kind === "submit") {
      const advancing = TIME_ADVANCING.has(want.op.intent!.kind);
      const pre = advancing ? auth.snapshot() : null;
      const result = JSON.parse(auth.submit(JSON.stringify(want.op.intent))) as { error?: string };
      if (advancing && result.error === undefined && pre !== null) undoStash = pre;
      got = result;
    } else if (want.op.kind === "read") {
      got = JSON.parse(auth.read(want.op.itemId!));
    } else {
      const ok = undoStash !== null;
      if (undoStash !== null) { auth.restore(undoStash); undoStash = null; }
      got = { ok };
    }
    expect(canonicalize(got), `step ${i} result`).toEqual(canonicalize(want.result));
    expect(canonicalize(JSON.parse(auth.snapshot())), `step ${i} snapshot`).toEqual(canonicalize(want.snapshot));
    expect(canonicalize(JSON.parse(auth.view())), `step ${i} view`).toEqual(canonicalize(want.view));
  });
}
```

- [ ] **Step 5: Fixture 1 — mob-reaction combat (rng-consuming)**

Create `conformance/fixtures/facade-mob-combat.gen.test.ts`:

```ts
/**
 * facade-mob-combat golden — the FIRST differential coverage of
 * runMobReactions + the execute turn-wrap.
 *
 * One PC (Ada, base sanity 3) shares "Hall" with two authored mobs. Sanity 3
 * puts the PC inside the Fear band (0 < sanity < 5), so the engine ITSELF
 * latches Fear at the first startTurn, and every subsequent startTurn draws a
 * shake-off clear roll — a genuine, engine-derived rng-draw consumer threaded
 * through the wrap on BOTH sides (startTurn tick + clear roll → dispatch →
 * mob strikes → nextPlayer). Fear blocks MOVE only, so wait/attack proceed.
 * Any specific shake-off round is fine — the SAME seeded stream must
 * reproduce the exchange byte-for-byte in Rust.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade1;
const EMPTY_CATALOG = { items: {}, aliases: {} };

describe("generate facade-mob-combat golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry();
    const template = authorTemplate("Facade Mob Combat (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        // sanity 3 → Fear band → clear roll drawn at every startTurn (see header)
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 3, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .mob("Brute", { stats: { [StatType.Health]: 6, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" })
      .mob("Shade", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "wait" } },                        // both mobs strike; Fear latches
      { kind: "submit", intent: { kind: "wait" } },                        // clear roll drawn; strikes again
      { kind: "submit", intent: { kind: "attack", targetId: "mob:Brute" } }, // PC hits back mid-exchange
      { kind: "submit", intent: { kind: "wait" } },
    ];
    const steps = writeFacadeFixture(here, "facade-mob-combat", SEED, oracle, EMPTY_CATALOG, ops);

    // Coverage bar: the exchange actually happened — step 0 carries mob strikes.
    const r0 = steps[0]!.result as { mobAttacks?: { name: string }[] };
    if (!r0.mobAttacks || r0.mobAttacks.length < 2) {
      throw new Error(`expected both mobs to strike on step 0, got ${JSON.stringify(r0.mobAttacks)}`);
    }
  });
});
```

(`writeFacadeFixture` must `return steps` — declare it `): Array<{ op: FacadeOp; result: unknown; snapshot: unknown; view: unknown }>` in Task 8 Step 3 and return the `runFacadeGolden` result it already computes; several generators assert coverage bars on it.)

Create `conformance/facade-mob-combat.test.ts`:

```ts
import { describe, it } from "vitest";
import { replayFacade } from "./facade-replay.ts";

describe("facade-mob-combat differential conformance", () => {
  it("Authority matches the seeded GameSession oracle per op", () => {
    replayFacade("facade-mob-combat");
  });
});
```

- [ ] **Step 6: Fixture 2 — free vs time-advancing (equip/open free; move/wait advance)**

Create `conformance/fixtures/facade-free-vs-advancing.gen.test.ts` (same skeleton as Step 5 — repeat it, do not reference it):

```ts
/**
 * facade-free-vs-advancing golden — proves equip/open do NOT trigger
 * startTurn/reactions/nextPlayer, and move/wait DO (round increments,
 * mob strikes land only on advancing ops).
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import { mulberry32 } from "../seeded-rng.ts";
import { itemToCatalogEntry } from "./facade-catalog.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade2;
const SWORD_KEY = "items/facade-sword";

const makeSword = () =>
  new Item({
    behaviorKey: SWORD_KEY, name: "Sword", type: ItemType.Weapon,
    stat: StatType.Health, modifier: 3, slot: SlotKind.Hand,
    maxDurability: 5, recipe: { metal: 1 },
  });

describe("generate facade-free-vs-advancing golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry();
    registry.registerItem(SWORD_KEY, makeSword);
    const template = authorTemplate("Facade Free vs Advancing (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Hall", { description: "A stone hall." })
      .room("Crypt", { description: "A dark-cornered crypt." })
      .startRoom("Hall")
      .exit("Hall", Directions.North, "Crypt")
      .loot("chest", { room: "Hall", items: [SWORD_KEY], description: "An old chest." })
      .mob("Lurker", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: { [SWORD_KEY]: ["sword", "blade"] },
      playerName: "Ada", archetype: "delver", rng,
    });

    // Resolve authored ids from the oracle view (loot content ids are engine-assigned).
    const vm = oracle.view();
    const chestId = vm.loot[0]!.id;
    const swordId = vm.loot[0]!.contents[0]!.id;

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "open", targetId: chestId } },   // FREE: no reaction, round 0
      { kind: "submit", intent: { kind: "take", targetId: swordId } },   // advancing: Lurker strikes, round 1
      { kind: "submit", intent: { kind: "equip", targetId: swordId } },  // FREE: no reaction, round 1
      { kind: "submit", intent: { kind: "wait" } },                       // advancing no-op: reactions + wrap
      { kind: "submit", intent: { kind: "move", dir: Directions.North } },// advancing: leaves the mob behind
      { kind: "submit", intent: { kind: "wait" } },                       // advancing in empty room: no attacks
    ];
    writeFacadeFixture(here, "facade-free-vs-advancing", SEED,
      oracle, { items: { [SWORD_KEY]: itemToCatalogEntry(makeSword()) }, aliases: { [SWORD_KEY]: ["sword", "blade"] } }, ops);
  });
});
```

Create `conformance/fixtures/facade-catalog.ts` — extract `itemToCatalogEntry` **verbatim** from `conformance/fixtures/items-actions.gen.test.ts:183-215` (the "Catalog exporter (verbatim from items-projection.gen.test.ts)" block) into a shared module and export it (leave the original file's local copy in place — do not refactor frozen generators):

```ts
/** Shared catalog exporter for facade fixtures — verbatim body of
 *  itemToCatalogEntry from items-actions.gen.test.ts (the "Catalog exporter"
 *  block). All four inert fields are always emitted so Rust deserialization
 *  does not fail on missing required fields. */
import type { Item } from "wickedways/lib/inventory";

export function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    // type and slot must be lowercase strings — TS ItemType values are already lowercase
    type: item.type as string,
    stat: item.stat as string,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      // droppable: omit when absent (Rust skip_serializing_if = None)
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    // Optional descriptor fields — emit only when present
    ...(item.slot !== undefined ? { slot: item.slot as string } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    // ── Inert fields — REQUIRED in the Rust ItemDescriptor; always emit ──
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}
```

Create `conformance/facade-free-vs-advancing.test.ts` (same 7-line replay wrapper as Step 5, with `replayFacade("facade-free-vs-advancing")`).

- [ ] **Step 7: Register the generators (MANDATORY — silent skip otherwise)**

In `conformance/fixtures/vitest.config.ts` append to `include`:

```ts
      "conformance/fixtures/facade-mob-combat.gen.test.ts",
      "conformance/fixtures/facade-free-vs-advancing.gen.test.ts",
```

- [ ] **Step 8: Generate, replay-fail, fix, replay-pass**

```bash
pnpm run fixtures:gen
```
Expected: the 6 new fixture files appear under `conformance/fixtures/`.

```bash
pnpm run test:conformance
```
Expected on first run: the two `facade-*` suites run (the replay config auto-globs `conformance/**/*.test.ts`). Any divergence (draw order across the wrap, cue ordering, `mobAttacks` shape) is a Rust bug — debug with the first differing step index, fix in `crates/`, rebuild (`pnpm run wasm:build:conformance`), rerun. Done when: ALL suites PASS, including every pre-existing one.

```bash
pnpm run fixtures:stable
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add conformance
git commit -m "test(conformance): facade differential harness (oracle GameSession) + mob-combat and free-vs-advancing fixtures"
```

---

### Task 9: Remaining facade fixtures

**Files:**
- Create: `conformance/fixtures/facade-ko-piling.gen.test.ts` + `conformance/facade-ko-piling.test.ts`
- Create: `conformance/fixtures/facade-afflicted-mob.gen.test.ts` + `conformance/facade-afflicted-mob.test.ts`
- Create: `conformance/fixtures/facade-talk.gen.test.ts` + `conformance/facade-talk.test.ts`
- Create: `conformance/fixtures/facade-loot.gen.test.ts` + `conformance/facade-loot.test.ts`
- Create: `conformance/fixtures/facade-legality.gen.test.ts` + `conformance/facade-legality.test.ts`
- Create: `conformance/fixtures/facade-undo.gen.test.ts` + `conformance/facade-undo.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (register all 6 generators)

**Interfaces:**
- Consumes: `OracleSession`, `writeFacadeFixture`, `FacadeOp`, `itemToCatalogEntry`, `replayFacade`, `mulberry32` — exactly as produced by Task 8.
- Produces: committed goldens covering the rest of the spec's fixture list. Startup-cue parity is asserted by `replayFacade` on EVERY fixture (satisfying the spec's "startup cues" fixture via the dread-carrying `facade-talk` campaign below).

Every generator follows this exact skeleton (repeated here so this task stands alone):

```ts
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x0; // ← unique per fixture
const EMPTY_CATALOG = { items: {}, aliases: {} };

describe("generate <name> golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry();
    const template = authorTemplate("<Title> (conformance)", registry, { rng, maxRounds: 20, baseEncounterChance: 0 })
      .archetype({ id: "delver", name: "Delver", baseStats: { /* per fixture */ } })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall");
      // + per-fixture rooms/mobs/loot
    const oracle = new OracleSession({ builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng });
    const ops: FacadeOp[] = [ /* per fixture */ ];
    writeFacadeFixture(here, "<name>", SEED, oracle, EMPTY_CATALOG, ops);
  });
});
```

…and every replay test is the 7-line `replayFacade("<name>")` wrapper from Task 8 Step 5.

Per-fixture specifics (each one is exactly the skeleton + these deltas):

- [ ] **Step 1: `facade-ko-piling`** (SEED `0xfacade3`)
  - Archetype baseStats: `{ [StatType.Health]: 3, [StatType.Sanity]: 0, [StatType.Energy]: 8 }` (sanity 0 → mitigation multiplier 2.0 → each strike deals 2 health; health 3 → the second strike KOs).
  - Two mobs in Hall: `.mob("First", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" })` and `.mob("Second", …same…)`.
  - Ops: `[{ kind: "submit", intent: { kind: "wait" } }, { kind: "submit", intent: { kind: "wait" } }]` — step 0: `First` strikes for 2 (health 3 → 1), `Second` strikes for… health 1 → 0 → KO latch → loop breaks after `Second`; step 1: PC is KO → reactions return empty (KO'd player not piled on). Coverage bar on the returned steps:
    ```ts
    const r0 = steps[0]!.result as { mobAttacks?: { name: string }[] };
    const names = (r0.mobAttacks ?? []).map((a) => a.name);
    if (names[names.length - 1] !== "Second" || new Set(names).size !== names.length) {
      throw new Error(`expected piling to stop at the KO strike, got ${JSON.stringify(names)}`);
    }
    const r1 = steps[1]!.result as { mobAttacks?: unknown[] };
    if ((r1.mobAttacks ?? []).length !== 0) {
      throw new Error("a downed player must not be piled on");
    }
    ```

- [ ] **Step 2: `facade-afflicted-mob`** (SEED `0xfacade4`)
  - Two mobs in Hall: `"Blocked"` authored with `stats: { [StatType.Health]: 5, [StatType.Sanity]: 0, [StatType.Energy]: 4 }` and `"Free"` with sanity 4.
  - The Panic latch: the PC attacks `"Blocked"` first (`{ kind: "attack", targetId: "mob:Blocked" }`) — `take_damage → reconcile` on a sanity-0 mob latches Panic (afflictions re-derive at reconcile), so from the NEXT reaction round the blocked mob's `attack` gate throws `Panicked: can only move.` and is swallowed while `"Free"` still strikes.
  - Ops: `[attack Blocked, wait, wait]`. Coverage assert in the generator: in steps 1-2, `mobAttacks` contains `"Free"` and NOT `"Blocked"`:
    ```ts
    for (const s of steps.slice(1)) {
      const names = ((s.result as { mobAttacks?: { name: string }[] }).mobAttacks ?? []).map((a) => a.name);
      if (names.includes("Blocked")) throw new Error("blocked mob must not strike");
      if (!names.includes("Free")) throw new Error("free mob must still strike");
    }
    ```
    If the engine does NOT latch Panic on the mob via that path (inspect the step-0 snapshot's afflictions for `mob:Blocked` when generating), fall back to KO-independence semantics: author `"Blocked"` with health 1 so the PC's attack KOs it — a KO'd mob is skipped by the loop guard, and `"Free"` still strikes; rename nothing (the fixture still proves the skip-and-continue loop shape). Either latch is engine-derived on both sides, never hand-edited.

- [ ] **Step 3: `facade-talk`** (SEED `0xfacade5`) — also the **startup-cues** fixture
  - Register the dread shadow so boot emits round-0 cues: `import { DREAD_KEY, dreadShadow } from "./dread-shadow.ts";` then `registry.registerMechanic(DREAD_KEY, dreadShadow);` and `.useMechanic(DREAD_KEY)` on the template. Boot now buffers `"Dread stirs."` → `golden.startupCues` non-empty → `replayFacade` proves `take_startup_cues` parity (core-begins lifecycle, end-to-end).
  - Ops: `[{ kind: "submit", intent: { kind: "talk", npcId: "anyone" } }, { kind: "submit", intent: { kind: "wait" } }]`.
  - Generator coverage assert: step 0's result is `{ cues: [...], error: "There's no one here to talk to." }` with **no `mobAttacks` key**, and step 0's snapshot equals… note: `talk` is time-advancing, so `startTurn` ran before the throw (dread's onTurnStart cue is IN `cues`) but `nextPlayer` did not (round still 0) — assert `snapshot.campaign.round === 0` at step 0 and `1` after step 1.

- [ ] **Step 4: `facade-loot`** (SEED `0xfacade6`)
  - Registry items: reuse `facade-catalog.ts`'s `itemToCatalogEntry`; register a lore-bearing consumable `items/facade-journal` (`new Item({ behaviorKey: "items/facade-journal", name: "Journal", type: ItemType.Consumable, stat: StatType.Health, modifier: 0, lore: "The pages are damp.", recipe: { item: 1 } })`) and the sword from Task 8 Step 6; loot `chest` in Hall holding both. Catalog JSON carries both entries + aliases.
  - Resolve ids from `oracle.view()` as in Task 8 Step 6.
  - Ops: `open chest` (free reveal) → `take journal` (auto-open already-open container, advancing) → `read journal` (lore cue, free) → `take sword` → `drop sword` (advancing) → `read sword-id` (not held → `[]`).
  - This is the `opened`-set ownership proof: the step views' `loot[0].opened` flag must match on both sides at every step.

- [ ] **Step 5: `facade-legality`** (SEED `0xfacade7`)
  - Campaign: Hall + chest holding the sword; PC holds nothing; one mob `"Wraith"` (health 1) in Hall so an `attack`-the-corpse case exists; plus a required item: register `items/facade-locket` with `droppable: false` (`new Item({ behaviorKey: "items/facade-locket", name: "Locket", type: ItemType.Accessory, stat: StatType.Sanity, modifier: 0, droppable: false, recipe: { item: 1 } })`) inside the chest.
  - Ops (every one asserted in the generator to produce the exact TS string):
    1. `open "nope"` → `There's nothing like that to open here.`
    2. `take "nope"` → `You don't see that here.`
    3. `drop "nope"` → `You aren't carrying that.`
    4. `equip "nope"` → `You aren't carrying that.`
    5. `use "nope"` → `You aren't carrying that.`
    6. `unequip "nope"` → `That isn't equipped.`
    7. `attack "nope"` → `There's nothing like that to attack here.`
    8. `take <locketId>` (succeeds, advancing — the wraith may strike)
    9. `drop <locketId>` → `You can't bring yourself to part with the Locket.`
    10. `attack "mob:Wraith"` (KOs it — health 1)
    11. `attack "mob:Wraith"` → `The Wraith is already dead.`
  - Generator assert loop:
    ```ts
    const wantErrors: Record<number, string> = {
      0: "There's nothing like that to open here.",
      1: "You don't see that here.",
      2: "You aren't carrying that.",
      3: "You aren't carrying that.",
      4: "You aren't carrying that.",
      5: "That isn't equipped.",
      6: "There's nothing like that to attack here.",
      8: "You can't bring yourself to part with the Locket.",
      10: "The Wraith is already dead.",
    };
    for (const [i, want] of Object.entries(wantErrors)) {
      const got = (steps[Number(i)]!.result as { error?: string }).error;
      if (got !== want) throw new Error(`step ${i}: expected "${want}", got "${got}"`);
    }
    ```

- [ ] **Step 6: `facade-undo`** (SEED `0xfacade8`)
  - Campaign: Hall + Crypt (exit north), chest with sword in Hall, one mob `"Lurker"` in Hall (so the undone action includes mob reactions).
  - Ops: `take sword` (advancing; Lurker strikes) → `undo` (must revert BOTH the take and the strike — snapshot equals the pre-take state) → `undo` (returns `{ ok: false }` — stash consumed) → `take sword` again (the rng stream has ADVANCED past the first exchange; both sides agree because both keep their rng across restore) → `equip sword` (free) → `undo` (reverts to… the post-second-take stash, NOT the equip — free ops don't restash) → `wait`.
  - Save/restore round-trip is implicitly proven every step (`snapshot()` is diffed after each op, and `undo` exercises `restore`).

- [ ] **Step 7: Register all 6 generators**

Append to `conformance/fixtures/vitest.config.ts` `include`:

```ts
      "conformance/fixtures/facade-ko-piling.gen.test.ts",
      "conformance/fixtures/facade-afflicted-mob.gen.test.ts",
      "conformance/fixtures/facade-talk.gen.test.ts",
      "conformance/fixtures/facade-loot.gen.test.ts",
      "conformance/fixtures/facade-legality.gen.test.ts",
      "conformance/fixtures/facade-undo.gen.test.ts",
```

- [ ] **Step 8: Generate → replay → fix divergences in Rust → green**

```bash
pnpm run fixtures:gen && pnpm run test:conformance && pnpm run fixtures:stable
```
Expected: all suites PASS (fix any divergence in `crates/`, rebuild the conformance wasm, rerun — never touch goldens/comparator).

- [ ] **Step 9: Commit**

```bash
git add conformance
git commit -m "test(conformance): remaining facade fixtures (ko-piling, afflicted mob, talk+startup, loot, legality strings, undo)"
```

---

### Task 10: Retire the `session.campaign` live-object read from audio (DTO feed)

**Ordering note:** lands BEFORE the cutover (Deviations #2) — the CRT/PnC controllers must stop touching `session.campaign` before Task 11 can delete it. Pre-cutover, everything here works against the TS-backed session unchanged.

**Files:**
- Modify: `packages/play-runtime/src/audio/contracts.ts` (`AudioDirector.tension` signature, :45-46)
- Modify: `packages/play-runtime/src/audio/audio-runtime.ts` (`update`, :100-104)
- Modify: `packages/play-runtime/src/audio/default-pack.ts` (`tension: () => 0`, :56 — arity-compatible, comment only)
- Modify: `packages/campaigns/src/hollow-house/audio.ts` (:12-19) + `packages/campaigns/src/hollow-house/audio.test.ts`
- Modify: `packages/play-surface/src/crt/controller.ts:123`, `packages/play-surface/src/pnc/controller.ts:126`

**Interfaces:**
- Consumes: `ViewModel` (`packages/play-runtime/src/viewmodel.ts`) — specifically `vm.status.sanity` (the active character's effective sanity; single-player ⇒ identical to the `c.party[0]` read the director does today).
- Produces: `AudioDirector.tension(view: ViewModel): number`; `AudioRuntime.update(view: ViewModel): void`. Controllers call `audio.update(vm)` with the `vm` their `refresh()` already computes.

- [ ] **Step 1: Write the failing director test**

In `packages/campaigns/src/hollow-house/audio.test.ts`, replace the `campaignWithSanity` stub with a ViewModel stub and update the assertions (keep the same numeric cases — the tension math is unchanged):

```ts
const vmWithSanity = (sanity: number) =>
  ({ status: { sanity } } as unknown as import("@wickedways/play-runtime").ViewModel);
```

and each `d.tension(campaignWithSanity(N))` becomes `d.tension(vmWithSanity(N))`.

Run: `pnpm vitest run packages/campaigns/src/hollow-house/audio.test.ts`
Expected: FAIL — type error / director still reads `c.party[0]`.

- [ ] **Step 2: Move the boundary to the DTO**

`packages/play-runtime/src/audio/contracts.ts` — replace the `tension` member (:45-46):

```ts
  /** Compute continuous tension (0–1) from the current ViewModel for the
   *  ambient bed. DTO-only: directors never see live engine objects
   *  (master-design invariant 4). */
  tension(view: ViewModel): number;
```

(add `import type { ViewModel } from "../viewmodel.js";` and delete the `ICampaign` import if now unused).

`packages/play-runtime/src/audio/audio-runtime.ts` — replace `update` (:100-104) and drop the `ICampaign` import:

```ts
  update(view: ViewModel): void {
    if (!this.#enabled) return;
    const directive = this.#active.ambient(this.#director.tension(view));
    this.#deps.bed.setTension(directive.bedTension);
  }
```

`packages/campaigns/src/hollow-house/audio.ts` — replace the director (:8-19):

```ts
/** Discrete cues use the base mapping; tension is sanity vs. a session high-water-mark. */
export function createHollowHouseDirector(): AudioDirector {
  const base = defaultDirector();
  let baseline = 0; // high-water-mark sanity seen this session
  return {
    react: base.react,
    tension: (view: ViewModel) => {
      const sanity = view.status.sanity;
      baseline = Math.max(baseline, sanity);
      return sanityToTension(sanity, baseline);
    },
  };
}
```

(import `ViewModel` from `@wickedways/play-runtime`; drop the now-unused `StatType`/`ICampaign` imports.)

`packages/play-surface/src/crt/controller.ts:123` and `packages/play-surface/src/pnc/controller.ts:126` — both sit inside a `refresh()` that already computed `const vm = session.view()`:

```ts
    // Drive the ambient drone from the viewmodel each turn (DTO boundary —
    // no live engine object crosses the surface seam).
    audio.update(vm);
```

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm vitest run packages/campaigns/src/hollow-house/audio.test.ts packages/play-surface/src && pnpm -r run typecheck
```
Expected: PASS. (`grep -rn "session.campaign" packages/ --include="*.ts" | grep -v test` must return NOTHING — verify.)

- [ ] **Step 4: Commit**

```bash
git add packages/play-runtime/src/audio packages/campaigns/src/hollow-house packages/play-surface/src
git commit -m "refactor(audio): tension reads the ViewModel DTO, not the live campaign (invariant 4)"
```

---

### Task 11: `GameSession` cutover to the `Authority`

**Files:**
- Create: `packages/play-runtime/src/engine-types.ts`, `packages/play-runtime/src/engine-node.ts`, `packages/play-runtime/src/engine-web.ts` (web stub completed in Task 12)
- Create: `packages/play-runtime/src/catalog.ts`
- Create: `packages/play-runtime/src/session.test.ts`
- Modify: `src/lib/serialization/registry.ts` (additive `itemKeys` getter)
- Modify: `packages/play-runtime/package.json` (`#engine` imports map)
- Modify: `packages/play-runtime/src/intent.ts`, `packages/play-runtime/src/viewmodel.ts`, `packages/play-runtime/src/session.ts`, `packages/play-runtime/src/index.ts`
- Modify: `packages/play-surface/src/{crt,pnc}/{controller,surface}.test.ts` (session stubs drop `get campaign()`)
- Delete: `packages/play-runtime/src/viewmodel.test.ts`

**Interfaces:**
- Consumes: `Authority` (Task 7) via `#engine`; generated `Intent`/`MobAttack`/`ExecuteResult`/`ViewModel` (Tasks 5-6) from `generated/bindings/`; `catalogFromRegistry` (created here); the facade fixtures (Tasks 8-9) as the behavioral contract.
- Produces: `GameSession` with the SAME public shape minus `campaign`; `SessionOptions` gains `seed?: number` and drops `rng` (no longer consumed — gameplay rng lives in the Authority). Node tests run against the real `pkg-node` wasm — **prerequisite: `pnpm run wasm:build`**.

- [ ] **Step 1: Registry item enumeration (additive oracle change)**

In `src/lib/serialization/registry.ts`, inside `CampaignRegistry` (after the `registerExit` method):

```ts
  /**
   * Keys of every registered item factory, in registration order. Read-only
   * enumeration used by the play-runtime to export the WASM item catalog;
   * registration stays write-only.
   */
  get itemKeys(): readonly string[] {
    return [...this.#items.keys()];
  }
```

Run: `pnpm run typecheck && pnpm vitest run src/lib/serialization` — Expected: PASS.

- [ ] **Step 2: Engine module selection (`#engine` subpath imports)**

`packages/play-runtime/package.json` — add the `imports` map (package-internal conditional resolution; Node/Vitest take `default`, Vite takes `browser`):

```json
{
  "name": "@wickedways/play-runtime",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "imports": {
    "#engine": {
      "browser": "./src/engine-web.ts",
      "default": "./src/engine-node.ts"
    }
  },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "lit": "^3", "wickedways": "workspace:*" },
  "devDependencies": { "@types/node": "^22.10.0" }
}
```

`packages/play-runtime/src/engine-types.ts`:

```ts
/** Shape of the wasm engine module (both wasm-pack targets emit it). Typed off
 *  the nodejs build's generated d.ts so typecheck requires `pnpm run wasm:build`
 *  to have run once. */
export type EngineModule = typeof import("../../../crates/wickedways-wasm/pkg-node/wickedways_wasm.js");
export type Authority = InstanceType<EngineModule["Authority"]>;
```

`packages/play-runtime/src/engine-node.ts`:

```ts
/** Node engine loader: the nodejs-target build loads synchronously via
 *  require — initEngine() is a no-op await. Selected by the `default`
 *  condition of the #engine imports map (vitest, conformance, any Node host). */
import { createRequire } from "node:module";
import type { EngineModule } from "./engine-types.js";

const require = createRequire(import.meta.url);
const mod = require("../../../crates/wickedways-wasm/pkg-node/wickedways_wasm.js") as EngineModule;

export async function initEngine(): Promise<void> {
  /* nodejs target is ready at import time */
}
export function engine(): EngineModule {
  return mod;
}
```

`packages/play-runtime/src/engine-web.ts` (stub now; real async import lands with the bundler build in Task 12):

```ts
/** Browser engine loader (bundler-target build). Task 12 wires the actual
 *  dynamic import; until then any browser use fails loudly. */
import type { EngineModule } from "./engine-types.js";

let mod: EngineModule | null = null;

export async function initEngine(): Promise<void> {
  if (mod) return;
  throw new Error("wasm engine web build not wired yet (Task 12)");
}
export function engine(): EngineModule {
  if (!mod) throw new Error("engine not initialized: await initEngine() before GameSession.start");
  return mod;
}
```

- [ ] **Step 3: Catalog exporter**

`packages/play-runtime/src/catalog.ts` — the body of `itemToCatalogEntry` is the **verbatim** exporter from `conformance/fixtures/items-actions.gen.test.ts:183-215`:

```ts
/**
 * Registry → Rust `Catalog` JSON ({ items: { behaviorKey: ItemDescriptor },
 * aliases }). The per-item body mirrors the conformance catalog exporter
 * byte-for-byte — the descriptor shape is what wickedways-core deserializes.
 */
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { Item } from "wickedways/lib/inventory";

export function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    // type and slot must be lowercase strings — TS ItemType values are already lowercase
    type: item.type as string,
    stat: item.stat as string,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      // droppable: omit when absent (Rust skip_serializing_if = None)
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    // Optional descriptor fields — emit only when present
    ...(item.slot !== undefined ? { slot: item.slot as string } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    // ── Inert fields — REQUIRED in the Rust ItemDescriptor; always emit ──
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

export function catalogFromRegistry(
  registry: CampaignRegistry,
  aliases: Record<string, string[]>,
  behaviors: Record<string, unknown> = {},
): { items: Record<string, unknown>; aliases: Record<string, string[]>; behaviors: Record<string, unknown> } {
  const items: Record<string, unknown> = {};
  for (const key of registry.itemKeys) {
    items[key] = itemToCatalogEntry(registry.item(key)());
  }
  return { items, aliases, behaviors };
}
```

> **⚠️ POST-DSL RECONCILIATION — the catalog must carry the campaign's scripted `behaviors`.**
> After the scripted-ops DSL, `Catalog` has a `behaviors` field and `Authority::new` →
> `validate_mechanics(&catalog)` **rejects any campaign whose registered mechanic/exit/victory
> keys are not resolvable** (native registry OR `catalog.behaviors`). A real campaign like Hollow
> House registers scripted behaviors (`hollowHouseBehaviors()` in
> `packages/campaigns/src/hollow-house/scripted.ts`), so `boot()` MUST thread them into the catalog
> — hence the `behaviors` parameter above (defaulting to `{}`). Source them from a new
> `SessionOptions.behaviors` (populated from the `CampaignManifest`, alongside `aliases`); pass
> `this.opts.behaviors ?? {}` at the boot call site. The plan's own **simple test campaigns register
> NO scripted behaviors**, so `behaviors` is `{}` for them and every fixture/test in this plan is
> unaffected — but omitting this wiring silently blocks Hollow House (the whole point of the cutover)
> from booting. `bindings:check` note: `behaviors` values are `BehaviorScript` (a generated ts-rs
> type); typing the map as `Record<string, BehaviorScript>` is preferred over `unknown` if the import
> is ergonomic.

- [ ] **Step 4: Boundary types from generated bindings**

`packages/play-runtime/src/intent.ts` — the hand-written union dies; the helper stays:

```ts
import type { Intent } from "../../../generated/bindings/Intent.ts";

export type { Intent };

/** Duplicated from the core's is_time_advancing for the HOST-side undo-stash
 *  decision only (the core classifies authoritatively inside submit). */
const TIME_ADVANCING = new Set<Intent["kind"]>([
  "move", "take", "drop", "use", "attack", "wait", "talk",
]);

export function isTimeAdvancing(intent: Intent): boolean {
  return TIME_ADVANCING.has(intent.kind);
}
```

`packages/play-runtime/src/viewmodel.ts` — full replacement (the live `view()` moves out of existence; types re-export the generated shapes, widened with the host-side presentation overlay):

```ts
/**
 * ViewModel types over the GENERATED core bindings (single source of truth —
 * master-design invariant 1). The core never emits presentation images for
 * rooms/occupants (presentation is not serialized); GameSession.view() overlays
 * them host-side, hence the widened `image?: string` fields here.
 * The live-campaign view() implementation now lives in the Rust core
 * (world/view.rs); its frozen TS oracle copy is conformance/fixtures/oracle-view.ts.
 */
import type { ViewModel as CoreViewModel } from "../../../generated/bindings/ViewModel.ts";
import type { ScopeEntity as CoreScopeEntity } from "../../../generated/bindings/ScopeEntity.ts";
import type { LootView as CoreLootView } from "../../../generated/bindings/LootView.ts";
import type { ExitView } from "../../../generated/bindings/ExitView.ts";
import type { LockedDoorView } from "../../../generated/bindings/LockedDoorView.ts";
import type { Inventory } from "../../../generated/bindings/Inventory.ts";
import type { StatusView } from "../../../generated/bindings/StatusView.ts";

export type ScopeKind = "occupant" | "item" | "loot";

/** Core ScopeEntity with the image narrowed to the string AssetRef surfaces use. */
export type ScopeEntity = Omit<CoreScopeEntity, "image" | "kind"> & {
  kind: ScopeKind;
  image?: string;
};
export type LootView = Omit<CoreLootView, "contents"> & { contents: ScopeEntity[] };
export type { ExitView, LockedDoorView, Inventory, StatusView };

export type ViewModel = Omit<CoreViewModel, "room" | "occupants" | "loot" | "scope" | "inventory" | "outcome"> & {
  room: CoreViewModel["room"] & { image?: string };
  occupants: ScopeEntity[];
  loot: LootView[];
  scope: ScopeEntity[];
  inventory: Omit<Inventory, "items" | "keys"> & { items: ScopeEntity[]; keys: ScopeEntity[] };
  outcome: string;
};
```

(If the generated field types differ in detail — e.g. `Inventory.items` already being `ScopeEntity[]` — adjust the `Omit` composition to whatever `pnpm run bindings:gen` actually produced in Task 6; the goal is: surfaces keep compiling with `image?: string` and `outcome: string`.)

- [ ] **Step 5: The cutover `session.ts` (full replacement)**

```ts
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { ArchetypeId } from "wickedways/lib/archetype";
import { engine } from "#engine";
import type { Authority } from "./engine-types.js";
import { catalogFromRegistry } from "./catalog.js";
import { isTimeAdvancing, type Intent } from "./intent.js";
import type { ViewModel } from "./viewmodel.js";
import type { SaveStore, SurfaceState } from "./savestore.js";

// Generated boundary types — single source of truth (invariant 1).
export type { MobAttack } from "../../../generated/bindings/MobAttack.ts";
export type { ExecuteResult } from "../../../generated/bindings/ExecuteResult.ts";
import type { ExecuteResult } from "../../../generated/bindings/ExecuteResult.ts";

export interface SessionOptions {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  saveStore: SaveStore;
  now: () => number;          // injected clock (no ambient Date.now)
  /** Authority rng seed; a fresh random seed per session when omitted. */
  seed?: number;
}

export class GameSession {
  #authority!: Authority;
  /** Host-side presentation overlay (invariant 6): captured at boot from the
   *  assembled TS campaign — presentation is never serialized, so the core
   *  cannot emit it. Mobs spawned post-boot have no image (as after a TS
   *  restore today). */
  readonly #roomImages = new Map<string, string>();
  readonly #occupantImages = new Map<string, string>();
  private undoSnapshot: string | null = null;

  private constructor(private readonly opts: SessionOptions) {}

  static start(opts: SessionOptions): GameSession {
    const s = new GameSession(opts);
    s.boot(opts.builder);
    return s;
  }

  private boot(builder: TemplateBuilder<string, string>): void {
    // TS authoring stays: assemble + PC setup produce the PRE-begin genesis.
    const { campaign, rooms } = assemble(builder.description, builder.registry);
    const pc = new PlayerCharacter({ campaign, name: this.opts.playerName });
    pc.joinCampaign();
    if (this.opts.archetype !== undefined) {
      pc.selectArchetype(this.opts.archetype as ArchetypeId);
    }
    pc.move(rooms.get(builder.description.startRoom!)!);
    campaign.gm = pc;

    // Presentation overlay capture (rooms + boot-time occupants, by id).
    this.#roomImages.clear();
    this.#occupantImages.clear();
    for (const room of rooms.values()) {
      const img = room.presentation?.image;
      if (img !== undefined) this.#roomImages.set(room.id, img);
      for (const occ of room.occupants) {
        const oimg = occ.presentation?.image;
        if (oimg !== undefined) this.#occupantImages.set(occ.id, oimg);
      }
    }

    // Core-begins lifecycle: serialize BEFORE beginCampaign; the Authority runs
    // begin_campaign itself and buffers the round-0 cues.
    const genesis = JSON.stringify(serializeCampaign(campaign));
    // POST-DSL: thread the campaign's scripted behaviors so validate_mechanics passes
    // (see the catalogFromRegistry reconciliation note). `{}` for behavior-less test campaigns.
    const catalog = JSON.stringify(
      catalogFromRegistry(this.opts.registry, this.opts.aliases, this.opts.behaviors ?? {}),
    );
    const seed = this.opts.seed ?? (Math.random() * 0x1_0000_0000) >>> 0;
    this.#authority?.free();
    this.#authority = new (engine().Authority)(genesis, catalog, seed);
  }

  takeStartupCues(): PresentationCue[] {
    return JSON.parse(this.#authority.takeStartupCues()) as PresentationCue[];
  }

  restart(): void {
    this.undoSnapshot = null;
    this.boot(this.opts.builder);
  }

  view(): ViewModel {
    const vm = JSON.parse(this.#authority.view()) as ViewModel;
    const roomImage = this.#roomImages.get(vm.room.id);
    if (roomImage !== undefined) vm.room.image = roomImage;
    for (const list of [vm.occupants, vm.scope]) {
      for (const e of list) {
        const img = this.#occupantImages.get(e.id);
        if (img !== undefined) e.image = img;
      }
    }
    return vm;
  }

  read(itemId: string): PresentationCue[] {
    return JSON.parse(this.#authority.read(itemId)) as PresentationCue[];
  }

  get finished(): boolean { return this.#authority.finished; }
  get outcome(): string { return this.#authority.outcome; }

  execute(intent: Intent): ExecuteResult {
    const advances = isTimeAdvancing(intent);
    const pre = advances ? this.#authority.snapshot() : null;
    const result = JSON.parse(this.#authority.submit(JSON.stringify(intent))) as ExecuteResult;
    // TS semantics: the undo stash updates only on a SUCCESSFUL advancing action.
    if (advances && result.error === undefined && pre !== null) this.undoSnapshot = pre;
    return result;
  }

  async save(slot: string, surface?: SurfaceState): Promise<void> {
    const snapshot = JSON.parse(this.#authority.snapshot()) as CampaignSnapshot;
    await this.opts.saveStore.save(slot, snapshot, this.opts.now(), surface);
  }

  async restore(slot: string): Promise<{ ok: boolean; surface?: SurfaceState }> {
    const loaded = await this.opts.saveStore.load(slot);
    if (!loaded) return { ok: false };
    this.#authority.restore(JSON.stringify(loaded.snapshot));
    return { ok: true, surface: loaded.surface };
  }

  undo(): boolean {
    if (!this.undoSnapshot) return false;
    this.#authority.restore(this.undoSnapshot);
    this.undoSnapshot = null;
    return true;
  }
}
```

**`#engine` note:** if `tsc` NodeNext or vitest has trouble resolving the bare `#engine` specifier, the fallback is a plain relative module `./engine.js` that re-exports from `./engine-node.js` and gets aliased to `./engine-web.js` in the Vite config (Task 12) — same two files, resolution moved into the bundler. Try `#engine` first (it is the standard package-imports mechanism). `Authority.free()` exists on every wasm-bindgen class (the generated d.ts includes it).

Deleted relative to the old file: `campaign` getter, `cueBuffer`, `opened` (now inside the Authority), `dispatch`, `runMobReactions`, `findInLoot`, `loadSnapshot`, the `deserializeCampaign`/`ProceduralViolation`/`Status`/`Mob`/`StatType`/`Campaign`/`ILoot`/`IItem` imports, and `SessionOptions.rng`.

- [ ] **Step 6: Index + surface-test stubs**

`packages/play-runtime/src/index.ts` — remove the dead live-view export; everything else keeps its name:

```ts
export { GameSession } from "./session.js";
export type { SessionOptions, ExecuteResult, MobAttack } from "./session.js";
export { bootLauncher, resolveCampaign } from "./launcher.js";
export { initEngine } from "#engine";
export { isTimeAdvancing } from "./intent.js";
export type { Intent } from "./intent.js";
export type { ViewModel, ScopeEntity, ExitView, LockedDoorView, LootView } from "./viewmodel.js";
```
(All lines below `LocalStorageSaveStore` in the current index.ts stay exactly as they are — only `export { view } from "./viewmodel.js";` is dropped and `initEngine` added.)

Search for stragglers and fix them:

```bash
grep -rn "from \"./viewmodel\|play-runtime\"" packages --include="*.ts" | grep -w view
grep -rn "get campaign()" packages/play-surface/src --include="*.test.ts"
```

Remove `get campaign() { ... }` from the four session stubs (`crt/controller.test.ts:59`, `crt/surface.test.ts:45`, `pnc/controller.test.ts:59`, `pnc/surface.test.ts:26`) — nothing reads it after Task 10.

Delete `packages/play-runtime/src/viewmodel.test.ts`:

```bash
git rm packages/play-runtime/src/viewmodel.test.ts
```

- [ ] **Step 7: Write the failing session unit tests**

`packages/play-runtime/src/session.test.ts` (node env; requires `pnpm run wasm:build` once):

```ts
import { describe, it, expect } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { GameSession } from "./session.js";
import type { SaveStore, SurfaceState } from "./savestore.js";

const SWORD_KEY = "items/test-sword";

function memoryStore(): SaveStore {
  const slots = new Map<string, { snapshot: CampaignSnapshot; surface?: SurfaceState }>();
  return {
    save: (slot, snapshot, _ts, surface) => { slots.set(slot, { snapshot, surface }); },
    load: (slot) => slots.get(slot) ?? null,
  } as unknown as SaveStore;
}

function startSession() {
  const registry = defineRegistry();
  registry.registerItem(SWORD_KEY, () =>
    new Item({
      behaviorKey: SWORD_KEY, name: "Sword", type: ItemType.Weapon,
      stat: StatType.Health, modifier: 3, slot: SlotKind.Hand,
      maxDurability: 5, recipe: { metal: 1 },
    }));
  const builder = authorTemplate("Session Test", registry, { maxRounds: 10, baseEncounterChance: 0 })
    .archetype({ id: "delver", name: "Delver", baseStats: {} })
    .room("Hall", { description: "A stone hall." })
    .room("Crypt", { description: "A crypt." })
    .startRoom("Hall")
    .exit("Hall", Directions.North, "Crypt")
    .exit("Crypt", Directions.South, "Hall")
    .loot("chest", { room: "Hall", items: [SWORD_KEY], description: "An old chest." });
  return GameSession.start({
    builder, registry, aliases: { [SWORD_KEY]: ["sword"] },
    playerName: "Tess", archetype: "delver",
    saveStore: memoryStore(), now: () => 0, seed: 0x5e551,
  });
}

describe("WASM-backed GameSession", () => {
  it("boots, views, and takes empty startup cues (no mechanics)", () => {
    const s = startSession();
    expect(s.takeStartupCues()).toEqual([]);
    const vm = s.view();
    expect(vm.room.name).toBe("Hall");
    expect(vm.status.locationName).toBe("Hall");
    expect(vm.exits.map((e) => e.dir)).toEqual([Directions.North]);
    expect(s.finished).toBe(false);
    expect(s.outcome).toBe("ongoing");
  });

  it("executes a move (advancing) and a talk rejection", () => {
    const s = startSession();
    const moved = s.execute({ kind: "move", dir: Directions.North });
    expect(moved.error).toBeUndefined();
    expect(moved.mobAttacks).toEqual([]);
    expect(s.view().room.name).toBe("Crypt");
    expect(s.view().status.turn).toBe(1); // single player: wrap advances the round
    const talk = s.execute({ kind: "talk", npcId: "nobody" });
    expect(talk.error).toBe("There's no one here to talk to.");
  });

  it("open (free) reveals loot without advancing; take auto-opens", () => {
    const s = startSession();
    const chestId = s.view().loot[0]!.id;
    const swordId = s.view().loot[0]!.contents[0]!.id;
    const opened = s.execute({ kind: "open", targetId: chestId });
    expect(opened.error).toBeUndefined();
    expect(s.view().status.turn).toBe(0);
    expect(s.view().loot[0]!.opened).toBe(true);
    const took = s.execute({ kind: "take", targetId: swordId });
    expect(took.error).toBeUndefined();
    expect(s.view().inventory.items.map((i) => i.name)).toEqual(["Sword"]);
  });

  it("save → restore round-trips; undo reverts an advancing action", async () => {
    const s = startSession();
    await s.save("slot-a");
    s.execute({ kind: "move", dir: Directions.North });
    expect(s.view().room.name).toBe("Crypt");
    expect(s.undo()).toBe(true);
    expect(s.view().room.name).toBe("Hall");
    expect(s.undo()).toBe(false); // stash consumed
    s.execute({ kind: "move", dir: Directions.North });
    const restored = await s.restore("slot-a");
    expect(restored.ok).toBe(true);
    expect(s.view().room.name).toBe("Hall");
    expect(s.view().status.turn).toBe(0);
  });

  it("restart re-boots a fresh world", () => {
    const s = startSession();
    s.execute({ kind: "move", dir: Directions.North });
    s.restart();
    expect(s.view().room.name).toBe("Hall");
    expect(s.view().status.turn).toBe(0);
    expect(s.undo()).toBe(false);
  });
});
```

(Adjust the `memoryStore` literal to the actual `SaveStore` interface in `packages/play-runtime/src/savestore.ts:1-47` — `load` may be async / return `{ snapshot, surface, savedAt }`; mirror whatever `LocalStorageSaveStore` implements.)

- [ ] **Step 8: Run to verify failure, then bring it green**

```bash
pnpm run wasm:build   # pkg-node must exist for #engine + typecheck
pnpm vitest run packages/play-runtime/src/session.test.ts
```
Expected first: FAIL while `session.ts` is still the TS-backed version (no `seed` option, `view()` shape) — then apply Steps 2-6 and rerun until PASS.

```bash
pnpm vitest run packages/play-runtime packages/play-surface && pnpm -r run typecheck && pnpm run typecheck && pnpm run lint
```
Expected: PASS — launcher tests (GameSession is mocked), map-model (generated `ExitView` shape), surfaces, intents all green.

```bash
pnpm run test:conformance
```
Expected: PASS — the frozen oracle (`conformance/fixtures/oracle-*.ts`) is untouched by the cutover; `fixtures:gen` still regenerates identically (`pnpm run fixtures:stable` to prove it).

- [ ] **Step 9: Commit**

```bash
git add -A packages/play-runtime packages/play-surface src/lib/serialization/registry.ts
git commit -m "feat(play-runtime): GameSession delegates to the WASM Authority (single-player cutover)"
```

---

### Task 12: Browser WASM loading + one-time async init

**Files:**
- Modify: `crates/wickedways-wasm` build scripts in root `package.json` (`wasm:build:web`)
- Modify: `packages/play-runtime/src/engine-web.ts` (real loader)
- Modify: `packages/play-runtime/src/launcher.ts` + `launcher.test.ts` (async boot)
- Modify: `packages/play/vite.config.ts` + `packages/play/package.json` (wasm plugins)
- Modify: `packages/play/src/main.ts` (await the async launcher; locate the exact entry with `grep -rn "bootLauncher" packages/play/src` — expected: one call site)

**Interfaces:**
- Consumes: `#engine` browser condition → `engine-web.ts`; the bundler-target build.
- Produces: `pnpm run wasm:build:web` → `crates/wickedways-wasm/pkg-web/`; `bootLauncher(...): Promise<void>` performing `await initEngine()` once before the first `mountSurface`; `GameSession.start` STAYS synchronous.

- [ ] **Step 1: Bundler-target build script**

Root `package.json`:

```json
"wasm:build:web": "wasm-pack build crates/wickedways-wasm --target bundler --out-dir pkg-web",
```

Run: `pnpm run wasm:build:web` — Expected: `pkg-web/` with `wickedways_wasm.js` (ESM, wasm-imports) + `.d.ts`.

- [ ] **Step 2: Real web loader**

`packages/play-runtime/src/engine-web.ts`:

```ts
/**
 * Browser engine loader: the bundler-target build initializes through the
 * module graph (ESM wasm integration — vite-plugin-wasm in @wickedways/play).
 * One-time async init; afterwards engine() is synchronous so GameSession.start
 * keeps its sync signature.
 */
import type { EngineModule } from "./engine-types.js";

let mod: EngineModule | null = null;

export async function initEngine(): Promise<void> {
  if (mod) return;
  mod = (await import(
    "../../../crates/wickedways-wasm/pkg-web/wickedways_wasm.js"
  )) as unknown as EngineModule;
}

export function engine(): EngineModule {
  if (!mod) {
    throw new Error("engine not initialized: await initEngine() before GameSession.start");
  }
  return mod;
}
```

- [ ] **Step 3: Async launcher (one-time init before first mount)**

`packages/play-runtime/src/launcher.ts` — change the signature and add the await as the FIRST statement (everything else in the function body is untouched):

```ts
import { initEngine } from "#engine";

export async function bootLauncher(
  app: HTMLElement,
  reg: { campaigns: CampaignManifest[]; surfaces: PlaySurface[] },
  opts: BootOpts,
): Promise<void> {
  // One-time WASM init: after this resolves, GameSession.start (inside
  // mountSurface) constructs Authorities synchronously.
  await initEngine();
  let handle: SurfaceHandle | null = null;
  // ... (rest of the current body, unchanged)
}
```

`packages/play-runtime/src/launcher.test.ts` — every `bootLauncher(...)` call becomes `await bootLauncher(...)` and its `it(...)` callback `async`. Add the engine mock next to the existing session mock so Node tests don't require the web build:

```ts
vi.mock("#engine", () => ({
  initEngine: async () => {},
  engine: () => ({}),
}));
```

`packages/play/src/main.ts` (per the Step-0 grep): `await bootLauncher(...)` (top-level await — the Vite build targets esnext after Step 4).

- [ ] **Step 4: Vite wiring**

```bash
pnpm --filter play add -D vite-plugin-wasm vite-plugin-top-level-await
```

`packages/play/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  server: { port: 5174 },
  plugins: [wasm(), topLevelAwait()],
  build: { target: "esnext" },
});
```

(If Vite 8/Rolldown ships native ESM-wasm integration and the plugins conflict, drop `vite-plugin-wasm` and keep the config minimal — the acceptance check is Step 5, not the plugin list.)

- [ ] **Step 5: Verify Node tests and the browser build**

```bash
pnpm vitest run packages/play-runtime && pnpm -r run typecheck
pnpm --filter play exec vite build
```
Expected: tests PASS (Node still resolves `#engine` → `engine-node`); `vite build` succeeds with the wasm chunk emitted.

Boot the dev server and smoke the real surface (campaign menu renders; starting a campaign that uses **no custom registered behaviors** reaches the first room; see the Known-gap note in Task 13 about hollow-house):

```bash
pnpm --filter play exec vite dev
```
Expected: app boots; no "engine not initialized" and no wasm-loading console errors on the menu → surface path.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/play packages/play-runtime pnpm-lock.yaml
git commit -m "feat(play): browser bundler-target wasm build + one-time async engine init"
```

---

### Task 13: `checks:phase2` full gate + living docs

**Files:**
- Modify: `package.json` (root — final `checks:phase2`)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the Phase-2 acceptance command and updated living documentation.

- [ ] **Step 1: Finalize the gate**

```json
"checks:phase2": "cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run wasm:build && node scripts/assert-no-conformance.mjs && pnpm run wasm:build:web && pnpm run test:conformance && pnpm run lint && pnpm run typecheck && pnpm -r run typecheck && pnpm run test",
```

Covers, in order: `no_std` core build; all Rust tests (incl. `submit`/`view`/`Authority`); bindings drift (incl. the 5 new types); default nodejs build + no-conformance-symbol assert (incl. `Authority` present); bundler build; the FULL conformance suite (raw-engine + 8 facade fixtures) on the conformance build; lint; root + workspace typechecks; the full vitest suite (incl. `session.test.ts` against real wasm — `wasm:build` ran earlier in the chain).

- [ ] **Step 2: Run it**

```bash
pnpm run checks:phase2
```
Expected: PASS end-to-end. This is the Phase-2a+2b acceptance run.

- [ ] **Step 3: Update `README.md` (living-docs convention)**

Locate the existing Rust-engine section (`grep -n "Rust" README.md`) and extend it (or add `## Rust engine core (migration)` if none) covering, in prose consistent with the README's voice:

- The single-player runtime now executes in the Rust core: `GameSession` delegates to a stateful WASM `Authority` (`crates/wickedways-wasm/src/authority.rs`); TS authoring still assembles campaigns and hands the core a pre-begin genesis snapshot; the core owns `begin_campaign`, the turn wrap, and solo-GM mob reactions (`World::submit`, `crates/wickedways-core/src/world/submit.rs`).
- The boundary carries only JSON: `Intent` in; `ExecuteResult{cues, mobAttacks?, error?}`, `ViewModel`, `CampaignSnapshot` out. Boundary TS types are ts-rs-generated in `generated/bindings/` (never hand-edited; `pnpm run bindings:check`).
- Build split: `pnpm run wasm:build` (default, shipped, **no** `conformance:*` ops — asserted by `scripts/assert-no-conformance.mjs`), `wasm:build:web` (browser bundler target, async-initialized once in `bootLauncher`), `wasm:build:conformance` (gate only).
- The differential gate now also drives the **facade**: seeded frozen-oracle `GameSession` fixtures (`conformance/fixtures/facade-*.gen.test.ts`) diff `{result, snapshot, view}` per intent against `Authority.submit` — first coverage of `runMobReactions` and the turn wrap. Regeneration: `pnpm run fixtures:gen`; gate: `pnpm run test:conformance`; full acceptance: `pnpm run checks:phase2`.
- Audio reads the `ViewModel` DTO (`AudioDirector.tension(view)`) — no surface touches a live engine object anymore.
- **Resolved (was a known gap; closed by the scripted-ops DSL sub-plan @ `7f9545c`):** hollow-house's `dread`/`storyteller`/`status-bar` mechanics, `study-door`/`attic-door` exits, and its 3 victory conditions are now authored as **scripts** in `packages/campaigns/src/hollow-house/scripted.ts` and resolve via `Catalog.behaviors` (native-first, then scripted), gated byte-for-byte against the original TS closures. So `Authority::new` → `validate_mechanics(&catalog)` **passes for hollow-house** once `boot()` threads `behaviors` into the catalog (Task 11) — the real-surface validation and Playwright e2e this plan targets are unblocked. **Remaining true gap:** mob **formations** (`Wraith`/`Revenant`) are NOT scripted — hollow-house uses fixed `.mob()` placement data (`baseEncounterChance: 0`, no formations registered), so there is nothing to resolve at `validate_mechanics` for formations; roving-encounter campaigns that register a formation key would still need a native or scripted formation (out of scope here, and not used by hollow-house). Confirm the e2e boots hollow-house through the WASM `Authority`; if a specific behavior still diverges, that is a differential-gate finding to fix in the AST/interpreter, not a reason to exclude the e2e.

Also update the `packages/play-runtime` mention (if any) to note `GameSession`'s Authority delegation and the removed `campaign` getter.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "chore(checks): finalize checks:phase2 gate; document the Phase-2 single-player cutover"
```

---

## Self-review notes (spec coverage)

- 2a Authority API (constructor/take_startup_cues/submit/view/read/snapshot/restore/finished/outcome): Task 7. Ported submit flow incl. free-action skip + error capture: Task 4. `run_mob_reactions`: Task 3. `Intent`/`is_time_advancing`: Task 2. `MobAttack`/`ExecuteResult` + ts-rs: Tasks 3-5. Build split + "no conformance:* ships": Task 1 (+7).
- 2b GameSession delegation, `opened` moved into Authority, undo host-side via snapshot/restore, restart, catalog JSON, pre-begin genesis: Task 11. Browser bundler build + one-time async init, `GameSession.start` stays sync: Task 12. `session.campaign` retirement (audio DTO): Task 10.
- Conformance strategy: harness + oracle (Task 8), all listed fixtures (Tasks 8-9; startup-cues asserted on every fixture and specifically non-empty in `facade-talk`; save→restore→undo in `facade-undo`; legality strings in `facade-legality`); raw-engine gate stays green under the conformance build (Tasks 1, 6, 8).
- Invariant check: 1 (generated types replace hand-written — Tasks 5, 11), 2 (orchestration in core — Tasks 3-4), 3 (seeded rng in handle, survives restore — Tasks 7, 8), 4 (JSON-only + campaign-getter removal — Tasks 7, 10, 11), 5 (`no_std` asserted every task), 6 (cues/viewmodel unchanged; presentation overlay host-side — Tasks 6, 11), 7 (`bindings:check` — Tasks 5, 6, 13).
- **Not mappable to this plan (spec line "Existing surface/e2e … run against the WASM-backed GameSession unchanged"):** true for play-runtime/play-surface unit tests (Tasks 11-12), NOT for the hollow-house Playwright e2e — hollow-house's registered custom behaviors have no Rust ops yet (see Task 13 Step 3's Known-gap). Requires a follow-up sub-plan; flagged to the plan's requester.





