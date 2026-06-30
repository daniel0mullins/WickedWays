# Rust Engine Core — Phase 1, Sub-plan 2 (Turn Loop + Movement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the id-keyed `World` to life with the campaign turn loop, player movement over behavior-free exits, lighting, the presentation cue model, and a thin `ViewModel` slice — gated by a new command-stream differential harness.

**Architecture:** Mutations are `impl World` methods that take a `&mut Vec<PresentationCue>` cue sink; a small `Command` enum + `apply_command` dispatches them to the active character; a WASM `replay_commands` entrypoint replays a command list and returns per-step `{cues, snapshot, viewThin}`. A TS oracle boots the **seed** campaign (`buildSeedCampaign()`), captures the started snapshot + per-step golden, and the Rust replay must match byte-for-byte under canonical JSON.

**Tech Stack:** Rust (edition 2021), serde 1 + serde_json 1, ts-rs 10.1, wasm-bindgen 0.2 / wasm-pack 0.15 (`--target nodejs`), TypeScript + vitest 4, pnpm 9.15.6.

## Global Constraints

- **Commit only on the existing branch `design/rust-engine-core`.** Never create, switch, or rename a branch. (A prior project lost time to a stray branch.)
- **`no_std`-friendly core.** `wickedways-core` builds with `--no-default-features`; `std`, ts-rs (`ts`), and scripting live behind cargo features. Use `alloc::{string::String, vec::Vec, collections::BTreeMap}` — never `std::` paths in non-`std` code. The phase gate builds `cargo build -p wickedways-core --no-default-features`. (Caught `f64::floor` and missing `alloc` imports in earlier sub-plans.)
- **Determinism / exact equality (invariant 3).** Deterministic iteration (`BTreeMap`/`BTreeSet` where applicable); conformance compares with **exact** canonical-JSON equality, never tolerance.
- **serde byte-compatibility with the TS snapshot.** All new serialized types match the TS JSON: `#[serde(rename_all = "camelCase")]` on structs, `rename_all` to the exact tag strings on enums, `#[serde(tag = "kind")]` on discriminated unions, `#[serde(default, skip_serializing_if = "Option::is_none")]` on optionals, `#[serde(transparent)]` on id newtypes. Integer fields stay integer-typed (`i64`/`u32`) — never `f64` (a prior `f64` emitted `50.0` vs `50`).
- **Generated bindings are build artifacts (invariant 7).** New exported types carry ts-rs derives behind the `ts` feature; `pnpm run bindings:check` must stay green (drift gate).
- **Illegal operations throw `ProceduralViolation`.** Lifecycle guards (move when roomless, end round before all acted, traverse an unbound keyed exit) return `Err(ProceduralViolation)`, mirroring the TS engine.
- **Do NOT Read subagent JSONL transcript output files** (they overflow context). **`.superpowers/` is gitignored.**

---

## File structure

**Created (Rust, `crates/wickedways-core/src/`):**
- `presentation.rs` — `PresentationCue` + supporting cue types, `CampaignOutcome`, `ActionKind`.
- `error.rs` — `ProceduralViolation`.
- `world/history.rs` — `ActionHistoryEntry` typed enum + small ref structs.
- `world/direction.rs` — `Direction` enum + `as_key`.
- `world/turn.rs` — turn-loop methods on `World`.
- `world/movement.rs` — `go`/`move`/`enter_room`/`exit_room`/`is_lit`/`record_action`.
- `world/view.rs` — `ThinViewModel` + `World::view_thin`.
- `world/command.rs` — `Command` enum + `apply_command`.

**Modified:**
- `crates/wickedways-core/src/lib.rs` — module wiring + feature gates.
- `crates/wickedways-core/src/world/mod.rs` — `mod` declarations; helper accessors (`active_character_id`).
- `crates/wickedways-core/src/world/snapshot.rs` — promote `outcome: String`→`CampaignOutcome`; `history: Value`→`Vec<ActionHistoryEntry>`.
- `crates/wickedways-wasm/src/lib.rs` — `replay_commands` entrypoint.
- `package.json` — `fixtures:gen` includes the new generator; `test:conformance` already globs `conformance/**`.
- `conformance/canonical-json.ts` — only if the gate reveals a set-ordering divergence.

**Created (conformance, TS):**
- `conformance/fixtures/turn-movement.gen.test.ts` — golden generator (isolated config).
- `conformance/fixtures/turn-movement.start.snapshot.json` — booted-seed replay seed (committed).
- `conformance/fixtures/turn-movement.golden.json` — per-step golden (committed).
- `conformance/turn-movement.test.ts` — Rust-replay differential test.

---

## Task 1: Presentation cue model

**Files:**
- Create: `crates/wickedways-core/src/presentation.rs`
- Modify: `crates/wickedways-core/src/lib.rs`, `crates/wickedways-core/src/world/snapshot.rs`
- Test: in `presentation.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces: `PresentationCue` enum (`#[serde(tag="kind", rename_all="camelCase")]`), `EntityRef`, `StatusField`, `MechanicCue`, `OutcomeNarration`, `AssetRef` (= `serde_json::Value` passthrough), `CampaignOutcome` (`#[serde(rename_all="kebab-case")]`), `ActionKind` (`#[serde(rename_all="camelCase")]`). All `#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]`, ts-rs `TS` behind `#[cfg_attr(feature = "ts", derive(TS))]`.
- Consumes: existing `EntityRef`-style id usage is by plain `String` here (cues carry display `{id,name}`, not branded ids — match TS `EntityRef { id: string; name: string }`).

**Reference (authoritative TS shapes — mirror exactly):**
`src/lib/presentation.ts:49-55` (the 6 variants), `:16-20,:22-30` (`EntityRef`, `StatusField`), `src/lib/mechanics/mechanic.ts:89-92` (`MechanicCue`), `src/lib/victory.ts:4-10,:18-21` (`CampaignOutcome`, `OutcomeNarration`), `src/lib/character/history.ts:11-19` (the `ActionKind` discriminants).

- [ ] **Step 1: Write failing serde tests**

In `presentation.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;

    fn json(c: &PresentationCue) -> serde_json::Value {
        serde_json::to_value(c).unwrap()
    }

    #[test]
    fn action_cue_move_serializes_camelcase_tagged() {
        let c = PresentationCue::Action {
            action: ActionKind::Move,
            actor: EntityRef { id: "c1".to_string(), name: "Heir".to_string() },
            sound: None,
        };
        assert_eq!(
            json(&c),
            serde_json::json!({ "kind": "action", "action": "move",
                "actor": { "id": "c1", "name": "Heir" } })
        );
    }

    #[test]
    fn visibility_cue_serializes() {
        let c = PresentationCue::Visibility {
            room: EntityRef { id: "r1".to_string(), name: "Cellar".to_string() },
            lit: false,
        };
        assert_eq!(json(&c), serde_json::json!({
            "kind": "visibility", "room": { "id": "r1", "name": "Cellar" }, "lit": false }));
    }

    #[test]
    fn mechanic_cue_serializes_with_text_only() {
        let c = PresentationCue::Mechanic { cue: MechanicCue { text: Some("You can't go that way.".to_string()), sound: None } };
        assert_eq!(json(&c), serde_json::json!({
            "kind": "mechanic", "cue": { "text": "You can't go that way." } }));
    }

    #[test]
    fn resolution_cue_serializes_timeout() {
        let c = PresentationCue::Resolution { outcome: CampaignOutcome::TimedOut, reason: None, narration: None };
        assert_eq!(json(&c), serde_json::json!({ "kind": "resolution", "outcome": "timed-out" }));
    }

    #[test]
    fn campaign_outcome_serializes_kebab() {
        assert_eq!(serde_json::to_value(CampaignOutcome::TimedOut).unwrap(), serde_json::json!("timed-out"));
        assert_eq!(serde_json::to_value(CampaignOutcome::Ongoing).unwrap(), serde_json::json!("ongoing"));
    }

    #[test]
    fn cue_roundtrips() {
        let c = PresentationCue::Resolution { outcome: CampaignOutcome::Won, reason: Some("reach-attic".to_string()), narration: None };
        let s = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<PresentationCue>(&s).unwrap(), c);
    }
}
```

- [ ] **Step 2: Run tests, verify they fail to compile** — `cargo test -p wickedways-core presentation`. Expected: FAIL (types undefined).

- [ ] **Step 3: Implement the cue model**

```rust
//! Presentation cues — the engine emits intent; the surface owns presentation
//! (invariant 6). JSON byte-compatible with `src/lib/presentation.ts`.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Opaque campaign-supplied asset reference (sound/image). Passthrough — the
/// engine never inspects it. Never emitted by sub-plan 2 (seed has no sounds).
pub type AssetRef = serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct EntityRef {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct StatusField {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emphasis: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct MechanicCue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<AssetRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct OutcomeNarration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<AssetRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "kebab-case")]
pub enum CampaignOutcome {
    Ongoing,
    Won,
    Lost,
    TimedOut,
    Ended,
}

/// The action-cue discriminant — kept in lockstep with `ActionHistoryEntry`
/// (Task 2). camelCase to match TS `ActionDetail["kind"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Attack,
    Move,
    PickUp,
    Drop,
    Escape,
    TakeDamage,
    Fumble,
    MechanicAction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PresentationCue {
    Action {
        action: ActionKind,
        actor: EntityRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sound: Option<AssetRef>,
    },
    Encounter {
        mob: EntityRef,
        room: EntityRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sound: Option<AssetRef>,
    },
    Visibility {
        room: EntityRef,
        lit: bool,
    },
    Resolution {
        outcome: CampaignOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        narration: Option<OutcomeNarration>,
    },
    Mechanic {
        cue: MechanicCue,
    },
    Status {
        fields: Vec<StatusField>,
    },
}
```

In `lib.rs` add `pub mod presentation;` (and `extern crate alloc;` already present from earlier sub-plans).

- [ ] **Step 4: Promote the snapshot `outcome` field to the enum**

In `snapshot.rs`, change `CampaignCoreSnapshot`:

```rust
// was: pub outcome: String, // CampaignOutcome string enum
pub outcome: crate::presentation::CampaignOutcome,
```

Confirm `from_snapshot`/`to_snapshot` in `mod.rs` only carry `outcome` (no `String`-specific handling); adjust if any code compares it as `&str`.

- [ ] **Step 5: Run tests + the existing round-trip + conformance gate**

Run: `cargo test -p wickedways-core` then `pnpm run test:conformance`
Expected: new cue tests PASS; the existing snapshot round-trip + sub-plan-1 conformance still PASS (the seed/hollow-house fixtures carry `"outcome":"ongoing"`, which the enum re-emits identically).

- [ ] **Step 6: Regenerate + check bindings**

Run: `pnpm run bindings:gen && pnpm run bindings:check`
Expected: `PresentationCue` and supporting types appear in generated bindings; drift check green.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/presentation.rs crates/wickedways-core/src/lib.rs crates/wickedways-core/src/world/snapshot.rs generated/
git commit -m "feat(core): presentation cue model + CampaignOutcome enum (sub-plan 2)"
```

---

## Task 2: Typed action history

**Files:**
- Create: `crates/wickedways-core/src/world/history.rs`
- Modify: `crates/wickedways-core/src/world/snapshot.rs` (history field), `crates/wickedways-core/src/world/mod.rs` (mod decl)
- Test: in `history.rs`

**Interfaces:**
- Produces: `ActionHistoryEntry` (`#[serde(tag="kind", rename_all="camelCase")]`), `RoomRef { id: RoomId, name: String }`, `TargetRef { id: CharacterId, name: String }`, `ItemRef { id: ItemId, name: String }`. `CharacterSnapshot.history: Vec<ActionHistoryEntry>`.
- Consumes: branded ids from `world::ids`; `StatType` from `crate::stats` (exists, sub-plan 0).

**Reference:** `src/lib/character/history.ts:11-19` — transcribe all eight variants exactly (field names + tag strings).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ids::RoomId;
    use alloc::string::ToString;

    #[test]
    fn move_entry_serializes() {
        let e = ActionHistoryEntry::Move {
            round: 0,
            room: RoomRef { id: RoomId("r1".to_string()), name: "Next".to_string() },
        };
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({
            "kind": "move", "round": 0, "room": { "id": "r1", "name": "Next" } }));
    }

    #[test]
    fn move_entry_roundtrips() {
        let e = ActionHistoryEntry::Move {
            round: 3,
            room: RoomRef { id: RoomId("r2".to_string()), name: "Start".to_string() },
        };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(serde_json::from_str::<ActionHistoryEntry>(&s).unwrap(), e);
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core history`. Expected: FAIL (undefined).

- [ ] **Step 3: Implement `history.rs`** — transcribe all 8 variants from `history.ts`:

```rust
//! Typed action history — JSON byte-compatible with `src/lib/character/history.ts`.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;
use crate::stats::StatType;
use crate::world::ids::{CharacterId, ItemId, RoomId};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct RoomRef { pub id: RoomId, pub name: String }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct TargetRef { pub id: CharacterId, pub name: String }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ItemRef { pub id: ItemId, pub name: String }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionHistoryEntry {
    Attack { round: i64, target: TargetRef },
    Move { round: i64, room: RoomRef },
    PickUp { round: i64, items: Vec<ItemRef> },
    Drop { round: i64, items: Vec<ItemRef> },
    Escape { round: i64, success: bool },
    TakeDamage { round: i64, amount: i64, stat: StatType },
    Fumble { round: i64, action: String },
    MechanicAction { round: i64, mechanic: String, action: String },
}
```

Add `pub mod history;` to `world/mod.rs`.

- [ ] **Step 4: Promote the snapshot field**

In `snapshot.rs` `CharacterSnapshot`:

```rust
// was: /// Inert here (ActionHistoryEntry[]) — passthrough.
//      pub history: Value,
pub history: Vec<crate::world::history::ActionHistoryEntry>,
```

- [ ] **Step 5: Run tests + round-trip + conformance**

Run: `cargo test -p wickedways-core` then `pnpm run test:conformance`
Expected: PASS — genesis history is `[]` in both fixtures, so the typed `Vec` round-trips identically.

- [ ] **Step 6: Bindings** — `pnpm run bindings:gen && pnpm run bindings:check`. Expected: green.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/history.rs crates/wickedways-core/src/world/snapshot.rs crates/wickedways-core/src/world/mod.rs generated/
git commit -m "feat(core): typed ActionHistoryEntry; promote history from inert Value (sub-plan 2)"
```

---

## Task 3: Turn loop

**Files:**
- Create: `crates/wickedways-core/src/error.rs`, `crates/wickedways-core/src/world/turn.rs`
- Modify: `crates/wickedways-core/src/lib.rs` (`pub mod error;`), `crates/wickedways-core/src/world/mod.rs` (`mod turn;`, `active_character_id` accessor)
- Test: in `turn.rs`

**Interfaces:**
- Produces (on `World`): `begin_campaign(&mut self, cues: &mut Vec<PresentationCue>)`, `next_player(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`, `end_round(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`, `start_turn(&mut self, actor: &CharacterId)`, `end_turn(&mut self, actor: &CharacterId)`, `active_character_id(&self) -> Result<CharacterId, ProceduralViolation>`. `ProceduralViolation(pub String)`.
- Consumes: `presentation::{PresentationCue, CampaignOutcome}`; campaign fields on `World` (`round`, `max_rounds`, `party_ids`, `active_character_index`, `acted_this_round`, `started`, `outcome`, `outcome_reason`).

**Reference:** `src/lib/campaign.ts` — `nextPlayer` (`:550-560`), `endRound` (`:478-501`), `#finish` (`:450-459`), `beginCampaign` (`:445`), `[DISPATCH_TURN]`/round dispatch (`:692-710`, no-op here).

- [ ] **Step 1: Write failing tests** (build a tiny `World` with a 1-member party):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{CampaignOutcome, PresentationCue};
    use crate::world::ids::CharacterId;
    // test-utils helper that builds a minimal started World with `party` ids,
    // `max_rounds`, round 0, outcome Ongoing, and a character per id.
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    #[test]
    fn next_player_single_member_wraps_and_advances_round() {
        let mut w = world_with_party(&["pc"], /*max_rounds*/ 10);
        let mut cues = Vec::new();
        w.next_player(&mut cues).unwrap();
        assert_eq!(w.campaign.round, 1);
        assert!(w.campaign.acted_this_round.is_empty()); // reset after end_round
        assert!(cues.is_empty()); // still ongoing, no resolution cue
    }

    #[test]
    fn end_round_before_all_acted_is_a_violation() {
        let mut w = world_with_party(&["a", "b"], 10);
        let mut cues = Vec::new();
        // only `a` acted
        w.campaign.acted_this_round = vec![cid("a")];
        assert!(w.end_round(&mut cues).is_err());
    }

    #[test]
    fn timeout_at_max_rounds_finishes_and_emits_resolution() {
        let mut w = world_with_party(&["pc"], 1);
        let mut cues = Vec::new();
        w.next_player(&mut cues).unwrap(); // round 0 -> 1 == max_rounds -> timed-out
        assert_eq!(w.campaign.outcome, CampaignOutcome::TimedOut);
        assert_eq!(cues, vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::TimedOut, reason: None, narration: None }]);
    }

    #[test]
    fn start_turn_resets_action_budget() {
        let mut w = world_with_party(&["pc"], 10);
        if let Some(c) = w.characters.get_mut(&cid("pc")) { c.actions_this_round = 2; }
        w.start_turn(&cid("pc"));
        assert_eq!(w.characters.get(&cid("pc")).unwrap().actions_this_round, 0);
    }
}
```

> The `world_with_party` helper belongs in a `#[cfg(test)] pub mod test_support;` under `world/` (create it in this task). It builds a `World` with the given party ids (each a minimal player `CharacterSnapshot` in no room), `started = true`, `round = 0`, `outcome = Ongoing`, `active_character_index = 0`, `acted_this_round = []`, and the given `max_rounds`.

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core turn`. Expected: FAIL (undefined).

- [ ] **Step 3: Implement `error.rs`**

```rust
//! Engine lifecycle-guard error (mirrors TS `ProceduralViolation`).
use alloc::string::String;
use core::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProceduralViolation(pub String);

impl fmt::Display for ProceduralViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}
#[cfg(feature = "std")]
impl std::error::Error for ProceduralViolation {}
```

- [ ] **Step 4: Implement `turn.rs`** — transcribe the TS loop. Outcome resolution is **timeout-only** (win/lose deferred to sub-plan 7); round/turn mechanic dispatch is a **no-op** (registry empty until sub-plan 6):

```rust
use alloc::format;
use alloc::vec::Vec;
use crate::error::ProceduralViolation;
use crate::presentation::{CampaignOutcome, PresentationCue};
use crate::world::ids::CharacterId;
use crate::world::World;

impl World {
    pub fn active_character_id(&self) -> Result<CharacterId, ProceduralViolation> {
        let i = self.campaign.active_character_index as usize;
        self.campaign.party_ids.get(i).cloned()
            .ok_or_else(|| ProceduralViolation(format!("no active character at index {i}")))
    }

    pub fn begin_campaign(&mut self, _cues: &mut Vec<PresentationCue>) {
        self.campaign.started = true;
        // onRoundStart mechanic dispatch is a no-op until sub-plan 6 (empty registry).
    }

    pub fn start_turn(&mut self, actor: &CharacterId) {
        if let Some(c) = self.characters.get_mut(actor) { c.actions_this_round = 0; }
        // character events + afflictions + mechanic turn-start: no-ops this sub-plan.
    }

    pub fn end_turn(&mut self, _actor: &CharacterId) {
        // character events + reconcile + mechanic turn-end: no-ops this sub-plan.
    }

    pub fn next_player(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        let active = self.active_character_id()?;
        if !self.campaign.acted_this_round.contains(&active) {
            self.campaign.acted_this_round.push(active);
        }
        let next = self.campaign.active_character_index + 1;
        if next as usize == self.campaign.party_ids.len() {
            self.campaign.active_character_index = 0;
            self.end_round(cues)?;
        } else {
            self.campaign.active_character_index = next;
        }
        Ok(())
    }

    pub fn end_round(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        let all_acted = self.campaign.party_ids.iter()
            .all(|id| self.campaign.acted_this_round.contains(id));
        if !all_acted {
            return Err(ProceduralViolation(
                "Attempted to end round before all characters have acted".into()));
        }
        // onRoundEnd dispatch: no-op (sub-plan 6).
        self.campaign.round += 1;
        self.campaign.acted_this_round.clear();
        // Minimal resolver: timeout only. Win/lose -> sub-plan 7.
        if self.campaign.round >= self.campaign.max_rounds {
            self.finish(CampaignOutcome::TimedOut, None, cues);
            return Ok(());
        }
        // onRoundStart dispatch: no-op (sub-plan 6).
        Ok(())
    }

    fn finish(&mut self, outcome: CampaignOutcome, reason: Option<alloc::string::String>,
              cues: &mut Vec<PresentationCue>) {
        self.campaign.outcome = outcome;
        self.campaign.outcome_reason = reason.clone();
        cues.push(PresentationCue::Resolution { outcome, reason, narration: None });
    }

    fn assert_running(&self) -> Result<(), ProceduralViolation> {
        if !self.campaign.started || self.campaign.outcome != CampaignOutcome::Ongoing {
            return Err(ProceduralViolation("campaign is not running".into()));
        }
        Ok(())
    }
}
```

Add `mod turn;`, `pub mod error;` (lib.rs), and `#[cfg(test)] pub mod test_support;` wiring.

- [ ] **Step 5: Run tests** — `cargo test -p wickedways-core` then `cargo build -p wickedways-core --no-default-features`. Expected: PASS + no_std builds.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/error.rs crates/wickedways-core/src/world/turn.rs crates/wickedways-core/src/world/test_support.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/lib.rs
git commit -m "feat(core): turn loop — next_player/end_round/timeout resolution (sub-plan 2)"
```

---

## Task 4: Movement + lighting

**Files:**
- Create: `crates/wickedways-core/src/world/direction.rs`, `crates/wickedways-core/src/world/movement.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (mod decls)
- Test: in `movement.rs`

**Interfaces:**
- Produces (on `World`): `is_lit(&self, room: &RoomId) -> bool`, `go(&mut self, actor: &CharacterId, dir: Direction, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`, `move_to(&mut self, actor: &CharacterId, room: RoomId, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`. `Direction` enum (`#[serde(rename_all="lowercase")]`, 8 variants) + `as_key(&self) -> &'static str`.
- Consumes: `ActionHistoryEntry::Move`, `RoomRef`, `ActionKind`, `EntityRef`, `PresentationCue`, exits map on `RoomSnapshot` (keyed by `String`), `ExitSnapshot` (`endpoint_ids`, `behavior_key`).

**Reference:** `src/lib/character/character.ts` `go` (`:1047-1063`), `move`/`#enterRoom` (`:1018-1032`), `recordAction` cue (`:523-528`); `src/lib/room.ts` `isLit` (`:113-211`), `enterRoom`/`exitRoom` (`:287-299`), `Directions` (`:19-31`). Read `attemptAction`/`recordAction` to mirror the budget tick points exactly (`actions_this_round` increments only on a committed action — NOT on a wall).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{ActionKind, EntityRef, PresentationCue};
    use crate::world::history::ActionHistoryEntry;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::world_two_rooms; // pc in "start", exit north -> "next"

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }
    fn rid(s: &str) -> RoomId { RoomId(s.into()) }

    #[test]
    fn go_over_behavior_free_exit_moves_updates_occupancy_and_emits_action_cue() {
        let mut w = world_two_rooms(/*next_dark=*/false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("next")));
        assert!(!w.rooms[&rid("start")].occupant_ids.contains(&cid("pc")));
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&cid("pc")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 1);
        assert_eq!(cues, vec![PresentationCue::Action {
            action: ActionKind::Move,
            actor: EntityRef { id: "pc".into(), name: "Heir".into() },
            sound: None }]);
        // history append
        assert!(matches!(w.characters[&cid("pc")].history.last(),
            Some(ActionHistoryEntry::Move { .. })));
    }

    #[test]
    fn entering_a_dark_room_emits_visibility_lit_false() {
        let mut w = world_two_rooms(/*next_dark=*/true);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &mut cues).unwrap();
        assert!(cues.iter().any(|c| matches!(c, PresentationCue::Visibility { lit: false, .. })));
    }

    #[test]
    fn go_at_a_wall_emits_cant_go_that_way_and_does_not_move_or_tick_budget() {
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::East, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, Some(rid("start")));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 0);
        assert_eq!(cues, vec![PresentationCue::Mechanic {
            cue: crate::presentation::MechanicCue {
                text: Some("You can't go that way.".into()), sound: None } }]);
    }

    #[test]
    fn go_through_a_keyed_exit_is_out_of_scope_and_errors() {
        let mut w = world_two_rooms(false);
        // mark the north exit as behavior-keyed
        // (test_support exposes a setter or build a keyed variant)
        w.make_north_exit_keyed("study-door");
        let mut cues = Vec::new();
        assert!(w.go(&cid("pc"), Direction::North, &mut cues).is_err());
    }

    #[test]
    fn is_lit_truth_table() {
        let w = world_two_rooms(true);
        assert!(w.is_lit(&rid("start")));   // not dark
        assert!(!w.is_lit(&rid("next")));   // dark, no light sources
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core movement`. Expected: FAIL.

- [ ] **Step 3: Implement `direction.rs`**

```rust
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    North, South, East, West, Northeast, Northwest, Southeast, Southwest,
}

impl Direction {
    pub fn as_key(&self) -> &'static str {
        match self {
            Direction::North => "north", Direction::South => "south",
            Direction::East => "east", Direction::West => "west",
            Direction::Northeast => "northeast", Direction::Northwest => "northwest",
            Direction::Southeast => "southeast", Direction::Southwest => "southwest",
        }
    }
}
```

- [ ] **Step 4: Implement `movement.rs`** — mirror the TS paths; scenes are **not** fired (deferred to sub-plan 6), occupancy is `Vec` push/retain in TS-insertion order:

```rust
use alloc::vec::Vec;
use crate::error::ProceduralViolation;
use crate::presentation::{ActionKind, EntityRef, MechanicCue, PresentationCue};
use crate::world::direction::Direction;
use crate::world::history::{ActionHistoryEntry, RoomRef};
use crate::world::ids::{CharacterId, RoomId};
use crate::world::World;

impl World {
    pub fn is_lit(&self, room: &RoomId) -> bool {
        let Some(r) = self.rooms.get(room) else { return true };
        if !r.dark { return true; }
        // Any placed light source -> lit. Broken-state and occupant-carried light
        // fold in with item behavior (sub-plan 3). Empty set in the corpus.
        !r.light_source_ids.is_empty()
    }

    fn entity_ref_char(&self, id: &CharacterId) -> EntityRef {
        let name = self.characters.get(id).map(|c| c.name.clone()).unwrap_or_default();
        EntityRef { id: id.0.clone(), name }
    }

    pub fn go(&mut self, actor: &CharacterId, dir: Direction,
              cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
        let here = self.characters.get(actor).and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("Cannot move: not in any room.".into()))?;
        let room = self.rooms.get(&here)
            .ok_or_else(|| ProceduralViolation("current room missing".into()))?;
        let Some(exit_id) = room.exits.get(dir.as_key()).cloned() else {
            cues.push(PresentationCue::Mechanic { cue: MechanicCue {
                text: Some("You can't go that way.".into()), sound: None } });
            return Ok(());
        };
        let exit = self.exits.get(&exit_id)
            .ok_or_else(|| ProceduralViolation("exit missing".into()))?;
        // A behavior-keyed exit needs the registry (sub-plan 6) to evaluate canPass.
        if exit.behavior_key.is_some() {
            return Err(ProceduralViolation(
                "keyed-exit traversal is out of scope until sub-plan 6".into()));
        }
        // Behavior-free exit: no preconditions (always passable), no pass message.
        let (a, b) = (exit.endpoint_ids.0.clone(), exit.endpoint_ids.1.clone());
        let dest = if a == here { b } else { a };
        self.move_to(actor, dest, cues)
    }

    pub fn move_to(&mut self, actor: &CharacterId, room: RoomId,
                   cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
        // exit old room (scene firing deferred to sub-plan 6)
        if let Some(prev) = self.characters.get(actor).and_then(|c| c.current_room_id.clone()) {
            if let Some(r) = self.rooms.get_mut(&prev) {
                r.occupant_ids.retain(|id| id != actor);
            }
        }
        // enter new room
        if let Some(c) = self.characters.get_mut(actor) { c.current_room_id = Some(room.clone()); }
        if let Some(r) = self.rooms.get_mut(&room) {
            if !r.occupant_ids.contains(actor) { r.occupant_ids.push(actor.clone()); }
        }
        if !self.is_lit(&room) {
            let name = self.rooms.get(&room).map(|r| r.name.clone()).unwrap_or_default();
            cues.push(PresentationCue::Visibility {
                room: EntityRef { id: room.0.clone(), name }, lit: false });
        }
        // record_action(move): tick budget, append history, emit action cue.
        let round = self.campaign.round;
        let room_name = self.rooms.get(&room).map(|r| r.name.clone()).unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.actions_this_round += 1;
            c.history.push(ActionHistoryEntry::Move {
                round, room: RoomRef { id: room.clone(), name: room_name } });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::Move, actor: self.entity_ref_char(actor), sound: None });
        Ok(())
    }
}
```

Add `pub mod direction;`, `mod movement;` to `world/mod.rs`, and the `world_two_rooms`/`make_north_exit_keyed` helpers to `test_support`.

> **Budget fidelity note for the implementer:** read `character.ts` `attemptAction`/`recordAction`. If the TS engine increments `actions_this_round` at a different point or blocks when the budget is exhausted, mirror it precisely — `actions_this_round` is a snapshot field compared byte-for-byte by Task 8. The conformance stream stays within budget, but the tick semantics must match.

- [ ] **Step 5: Run** — `cargo test -p wickedways-core` + `cargo build -p wickedways-core --no-default-features`. Expected: PASS + no_std.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/direction.rs crates/wickedways-core/src/world/movement.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/world/test_support.rs generated/
git commit -m "feat(core): movement over behavior-free exits + lighting + visibility cue (sub-plan 2)"
```

---

## Task 5: Thin ViewModel

**Files:**
- Create: `crates/wickedways-core/src/world/view.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs`
- Test: in `view.rs`

**Interfaces:**
- Produces (on `World`): `view_thin(&self) -> Result<ThinViewModel, ProceduralViolation>`. `ThinViewModel { room: ThinRoom, occupants: Vec<ThinOccupant>, status: ThinStatus, outcome: CampaignOutcome, finished: bool }`, `ThinRoom { id, name, description, is_lit }`, `ThinOccupant { id, name, kind }` (kind = the literal `"occupant"`), `ThinStatus { turn: i64, max_turns: i64 }`. All `#[serde(rename_all="camelCase")]`, ts-rs gated.
- Consumes: active character + its room; `is_lit`; campaign `round`/`max_rounds`/`outcome`.

**Reference:** `packages/play-runtime/src/viewmodel.ts:60-167` — but populate **only** the thin slice. `occupants` filters out the active character and lists `{id, name, kind:"occupant"}` (no `health`/`defeated`/`image` — those land in sub-plans 3/4). `finished` = `outcome != Ongoing`.

- [ ] **Step 1: Write failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::CampaignOutcome;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_two_rooms;

    #[test]
    fn view_thin_reports_room_status_and_outcome() {
        let w = world_two_rooms(false); // pc "Heir" in "start"="Start"
        let v = w.view_thin().unwrap();
        assert_eq!(v.room.name, "Start");
        assert!(v.room.is_lit);
        assert_eq!(v.status.turn, 0);
        assert_eq!(v.outcome, CampaignOutcome::Ongoing);
        assert!(!v.finished);
        assert!(v.occupants.is_empty()); // only the pc, filtered out
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core view`. Expected: FAIL.

- [ ] **Step 3: Implement `view.rs`** (struct + `view_thin`; serialize with serde for the gate). Add `mod view;` to `world/mod.rs`.

- [ ] **Step 4: Run** — `cargo test -p wickedways-core` + `cargo build -p wickedways-core --no-default-features` + `pnpm run bindings:gen && pnpm run bindings:check`. Expected: PASS + green.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/view.rs crates/wickedways-core/src/world/mod.rs generated/
git commit -m "feat(core): thin ViewModel slice (room/occupants/status/outcome) (sub-plan 2)"
```

---

## Task 6: Command dispatch + WASM replay entrypoint

**Files:**
- Create: `crates/wickedways-core/src/world/command.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs`, `crates/wickedways-wasm/src/lib.rs`
- Test: in `command.rs` (Rust) + a WASM smoke assertion

**Interfaces:**
- Produces: `Command` enum (`#[serde(tag="kind", rename_all="camelCase")]`) — `StartTurn`, `EndTurn`, `Go { dir: Direction }`, `NextPlayer`; all apply to the **active** character. `apply_command(&mut World, Command, &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`. WASM `replay_commands(start_snapshot_json: &str, commands_json: &str) -> Result<String, JsValue>` returning a JSON array of `{ command, cues, snapshot, viewThin }` (one entry per command).
- Consumes: Task 3/4/5 methods.

- [ ] **Step 1: Write failing Rust test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::direction::Direction;
    use crate::world::test_support::world_two_rooms;

    #[test]
    fn apply_go_dispatches_to_active_character() {
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        apply_command(&mut w, Command::Go { dir: Direction::North }, &mut cues).unwrap();
        assert_eq!(cues.len(), 1); // action move cue
    }

    #[test]
    fn command_json_tag_shape() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "go", "dir": "north" })).unwrap();
        assert!(matches!(c, Command::Go { dir: Direction::North }));
        assert!(matches!(
            serde_json::from_value::<Command>(serde_json::json!({ "kind": "nextPlayer" })).unwrap(),
            Command::NextPlayer));
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core command`. Expected: FAIL.

- [ ] **Step 3: Implement `command.rs`**

```rust
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::direction::Direction;
use crate::world::World;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    StartTurn,
    EndTurn,
    Go { dir: Direction },
    NextPlayer,
}

pub fn apply_command(world: &mut World, cmd: Command,
                     cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
    let actor = world.active_character_id()?;
    match cmd {
        Command::StartTurn => { world.start_turn(&actor); Ok(()) }
        Command::EndTurn => { world.end_turn(&actor); Ok(()) }
        Command::Go { dir } => world.go(&actor, dir, cues),
        Command::NextPlayer => world.next_player(cues),
    }
}
```

Add `pub mod command;` to `world/mod.rs`.

- [ ] **Step 4: Implement the WASM entrypoint** in `wickedways-wasm/src/lib.rs`:

```rust
#[wasm_bindgen]
pub fn replay_commands(start_snapshot_json: &str, commands_json: &str) -> Result<String, JsValue> {
    use wickedways_core::presentation::PresentationCue;
    use wickedways_core::world::command::{apply_command, Command};
    use wickedways_core::world::World;
    let snap = serde_json::from_str(start_snapshot_json).map_err(err)?;
    let mut world = World::from_snapshot(snap);
    let commands: Vec<Command> = serde_json::from_str(commands_json).map_err(err)?;
    let mut steps = Vec::new();
    for cmd in commands {
        let mut cues: Vec<PresentationCue> = Vec::new();
        apply_command(&mut world, cmd.clone(), &mut cues).map_err(|e| err_str(e.0))?;
        let view = world.view_thin().map_err(|e| err_str(e.0))?;
        steps.push(serde_json::json!({
            "command": cmd,
            "cues": cues,
            "snapshot": world.to_snapshot(),
            "viewThin": view,
        }));
    }
    serde_json::to_string(&steps).map_err(err)
}
// `err`/`err_str`: existing/small helpers turning errors into JsValue.
```

- [ ] **Step 5: Run + build WASM** — `cargo test -p wickedways-core` then `pnpm run wasm:build`. Expected: PASS + WASM builds.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/command.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-wasm/src/lib.rs
git commit -m "feat(wasm): Command enum + replay_commands entrypoint (sub-plan 2)"
```

---

## Task 7: TS oracle golden generator

**Files:**
- Create: `conformance/fixtures/turn-movement.gen.test.ts`
- Create (committed output): `conformance/fixtures/turn-movement.start.snapshot.json`, `conformance/fixtures/turn-movement.golden.json`
- Modify: `package.json` (`fixtures:gen` runs this generator under the isolated fixtures config)

**Interfaces:**
- Produces: a `start.snapshot.json` (booted-seed campaign serialized) and a `golden.json` `{ commands: Command[], steps: [{ command, cues, snapshot, viewThin }] }` produced by driving the **engine directly** and capturing cues via `campaign.onCue`.

**Reference:** `packages/seed/src/index.ts` (`buildSeedCampaign()` → booted `{ campaign }`; rooms `Start`↔`Next` via north; `maxRounds` 10); `packages/play-runtime/src/session.ts` for the `serializeCampaign`/`view` imports; the engine methods `campaign.activeCharacter.go(dir)`, `campaign.nextPlayer()`, `pc.startTurn()`.

> **Why the seed, not Hollow House:** the seed has **no mechanics**, so the stream emits only the cues sub-plan 2 produces (Hollow House's status mechanic would emit `status` cues the Rust core can't yet make). The seed's `maxRounds: 10` makes the **timeout → resolution cue** reachable inside the gate. The dark-room **visibility** cue is covered by the Rust unit test in Task 4 (seed rooms aren't dark).

- [ ] **Step 1: Write the generator**

```ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedCampaign } from "../../packages/seed/src/index.ts";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";

const here = dirname(fileURLToPath(import.meta.url));

// Thin-view projection mirroring the Rust ThinViewModel (room/occupants/status/outcome).
function viewThin(campaign: any) {
  const pc = campaign.activeCharacter;
  const room = pc.currentRoom;
  return {
    room: { id: room.id, name: room.name, description: room.description, isLit: room.isLit },
    occupants: room.occupants.filter((o: any) => o.id !== pc.id)
      .map((o: any) => ({ id: o.id, name: o.name, kind: "occupant" })),
    status: { turn: campaign.round, maxTurns: campaign.maxRounds },
    outcome: campaign.outcome,
    finished: campaign.finished,
  };
}

describe("generate turn-movement golden", () => {
  it("writes the started seed snapshot + per-step golden", () => {
    const { campaign } = buildSeedCampaign(); // booted: PC "..." in Start, party=[pc], round 0
    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "turn-movement.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    // Deterministic command list. StartTurn resets budget at each turn boundary;
    // a wall move (east — no exit) exercises the mechanic cue; repeated nextPlayer
    // drives round -> maxRounds (10) -> timeout resolution.
    const commands: any[] = [
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North }, // Start -> Next (action cue)
      { kind: "go", dir: Directions.South }, // Next -> Start
      { kind: "go", dir: Directions.East },  // wall -> "You can't go that way."
      { kind: "nextPlayer" },                // wraps -> endRound -> round 1
      { kind: "startTurn" },
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, { kind: "nextPlayer" },
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, { kind: "nextPlayer" },
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // ... reach round 10 -> timed-out
    ];

    const pc = () => campaign.activeCharacter;
    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn": pc().startTurn(); break;
        case "endTurn": pc().endTurn(); break;
        case "go": pc().go(cmd.dir); break;
        case "nextPlayer": campaign.nextPlayer(); break;
      }
      return { command: cmd, cues: drain(), snapshot: serializeCampaign(campaign), viewThin: viewThin(campaign) };
    });

    writeFileSync(join(here, "turn-movement.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n");
  });
});
```

> **Implementer:** confirm the exact `nextPlayer` count that reaches `round == maxRounds` (10) and that the final step's cues contain the `resolution` (`timed-out`) cue; trim/extend the `nextPlayer` list so the timeout lands on the **last** step. Verify the booted seed's active PC starts in `Start` and `actionsPerRound` accommodates the two `go`s in turn 1 (insert an extra `startTurn` if the budget is < 3). If `nextPlayer` after `finish` would throw (campaign no longer running), the last command must be the one that triggers timeout — do not advance past it.

- [ ] **Step 2: Add the script** to `package.json` so `fixtures:gen` also runs this generator under `conformance/fixtures/vitest.config.ts` (the isolated config that the **main** `test:conformance` excludes — preventing the self-referential-gate bug from sub-plan 1).

- [ ] **Step 3: Generate + inspect**

Run: `pnpm run fixtures:gen`
Expected: both files written; manually confirm `turn-movement.golden.json` shows action cues on the two successful `go`s, a `mechanic` "You can't go that way." on the wall, `round` incrementing in snapshots, and a `resolution`/`timed-out` cue on the final step.

- [ ] **Step 4: Verify the main gate does NOT regenerate**

Run: `pnpm run test:conformance` twice; `git status` must show the golden files **unchanged** between runs (the generator is excluded from the main gate).

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/turn-movement.gen.test.ts conformance/fixtures/turn-movement.start.snapshot.json conformance/fixtures/turn-movement.golden.json package.json
git commit -m "test(conformance): seed turn-movement golden generator + fixtures (sub-plan 2)"
```

---

## Task 8: Command-stream differential conformance test

**Files:**
- Create: `conformance/turn-movement.test.ts`
- Modify: `conformance/canonical-json.ts` (**only if** the gate reveals a set-ordering divergence), `package.json` (`checks` alias)
- Reference: `conformance/world-roundtrip.test.ts` (sub-plan 1 pattern: `createRequire` to load the WASM `pkg`, canonical comparison).

**Interfaces:**
- Consumes: WASM `replay_commands` (Task 6), `turn-movement.start.snapshot.json` + `turn-movement.golden.json` (Task 7), `canonicalize` from `canonical-json.ts`.

- [ ] **Step 1: Write the differential test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js"); // path per sub-plan 1

const start = readFileSync(join(here, "fixtures/turn-movement.start.snapshot.json"), "utf8");
const golden = JSON.parse(readFileSync(join(here, "fixtures/turn-movement.golden.json"), "utf8"));

describe("turn-movement differential conformance", () => {
  it("Rust replay matches the TS oracle per step (cues + snapshot + thin view)", () => {
    const out = JSON.parse(wasm.replay_commands(start, JSON.stringify(golden.commands)));
    expect(out.length).toBe(golden.steps.length);
    out.forEach((step: any, i: number) => {
      const want = golden.steps[i];
      expect(canonicalize(step.cues)).toEqual(canonicalize(want.cues));
      expect(canonicalize(step.snapshot)).toEqual(canonicalize(want.snapshot));
      expect(canonicalize(step.viewThin)).toEqual(canonicalize(want.viewThin));
    });
  });
});
```

- [ ] **Step 2: Run** — `pnpm run wasm:build && pnpm run test:conformance`. Expected: PASS.

- [ ] **Step 3: If snapshots diverge on `occupantIds`/`actedThisRound` ordering** (and only then), add field-specific sorting for those two arrays to `canonicalize` in `canonical-json.ts` — **never sort `partyIds`** (turn order). Re-run. If they already match (the deterministic identical stream produces identical insertion order), make **no** comparator change.

- [ ] **Step 4: Update the phase checks alias** in `package.json` so `checks:phase1` (or a new `checks:phase2` honest alias) runs: `cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run test:conformance`. Keep it honest (no skipped steps).

- [ ] **Step 5: Full gate** — run the phase checks command end-to-end. Expected: all green (Rust unit + no_std + bindings drift + both conformance suites).

- [ ] **Step 6: Commit**

```bash
git add conformance/turn-movement.test.ts conformance/canonical-json.ts package.json
git commit -m "test(conformance): command-stream differential gate for turn loop + movement (sub-plan 2)"
```

---

## Self-review notes (author)

- **Spec coverage:** turn loop (T3), timeout outcome (T3), movement/occupancy/budget/action cue (T4), "can't go that way" (T4), lighting + visibility cue (T4 + unit test), cue model (T1), thin ViewModel (T5), command harness + WASM (T6), differential gate over seed (T7/T8). `canPass`/locked doors/scenes/win-lose/items/combat are explicit non-goals (later sub-plans) — not in any task.
- **Type consistency:** `PresentationCue`/`ActionKind`/`CampaignOutcome` (T1) consumed by T3/T4/T5/T6; `ActionHistoryEntry`/`RoomRef` (T2) consumed by T4; `Direction` (T4) consumed by T6; `ThinViewModel` (T5) consumed by T6's `replay_commands`. `apply_command` signature is stable across T6/T7/T8.
- **Carried sub-plan-1 notes honored:** integer-typed counters (no `f64`) — Global Constraints; `occupantIds`/`actedThisRound` ordering handled by matching-insertion-order with a comparator fallback (T8 Step 3), `partyIds` never sorted; the isolated fixture generator config prevents the self-referential-gate bug (T7 Steps 2/4).
- **Risk watch (flag during execution):** Task 4's budget tick points (read `attemptAction`/`recordAction`) and Task 7's exact `nextPlayer`-to-timeout count are the two places most likely to need a fix loop.
