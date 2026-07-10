# Rust Engine — Phase 1, Sub-plan 7: Victory Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the TS campaign victory-condition system (round-end `resolveOutcome`, manual `endCampaign`→`ended`, authored outcome narration, the `resolution` cue) to the Rust core, verified byte-for-byte by four new differential fixtures.

**Architecture:** A new `world/victory.rs` provides a `VictoryConditionBehavior` trait + `victory_behavior(key)` registry mirroring `world/exits.rs`. `turn.rs`'s round-end path gains a `resolve_outcome` (lose→win→timeout order) that replaces the timeout-only stub, `finish` derives narration, and a new `end_campaign` + `Command::EndCampaign` cover the manual end. The four inert victory snapshot fields become typed (byte-compatible). Conformance conditions are native Rust impls + matched TS shadow closures registered under a shared key.

**Tech Stack:** Rust (`no_std` core, `alloc` only), `serde`/`serde_json`, TypeScript oracle + Vitest differential harness, `wasm-pack`.

## Global Constraints

- **The differential conformance gate is the authority.** Never edit a golden or `conformance/canonical-json.ts` to force a pass; fix divergences in Rust source (or a faithful fixture correction).
- **`no_std` core:** `alloc::` only, never `std::`. Conformance behaviors stay behind `#[cfg(any(test, feature = "conformance"))]`, absent from the default build (`cargo build -p wickedways-core --no-default-features`).
- **Native-registry + matched-TS-shadow:** registry-bound behaviors are compiled-in Rust impls keyed by `behavior_key`; conformance behaviors get a matched TS shadow registered under the same key.
- **No unintended golden churn.** The snapshot-typing change must be byte-compatible; existing goldens/start-snapshots and the `turn-movement` fixture must stay green. **No `SCHEMA_VERSION` bump.**
- **Exact `resolveOutcome` order:** loss list → win list → `round >= maxRounds` → ongoing. First truthy wins; loss precedes win; timeout only if nothing else fired. Evaluation runs **after** the round increment.
- **Conformance condition key:** `conformance:round-reached`, firing at `round >= 2` (`THRESHOLD = 2`).
- Full gate `pnpm run checks:phase3` EXIT 0 + `pnpm run fixtures:stable` EXIT 0 (run post-commit).

## Context an engineer needs

- **The round-end path** lives in `crates/wickedways-core/src/world/turn.rs`. `next_player` (single/last party member) wraps to `end_round`, which currently does: `assert_running` → all-acted check → `dispatch_round(RoundPhase::End)` (BEFORE increment) → `round += 1` → `acted_this_round.clear()` → **timeout-only stub** → `dispatch_round(RoundPhase::Start)` (only when ongoing). We replace the stub.
- **`finish(outcome, reason, cues)`** (turn.rs) sets `campaign.outcome`/`outcome_reason` and pushes `PresentationCue::Resolution { outcome, reason, narration }`. It currently hard-codes `narration: None`.
- **The registry template** is `crates/wickedways-core/src/world/exits.rs`: a `pub trait ExitBehavior: Sync`, a `pub fn exit_behavior(key) -> Option<&'static dyn ExitBehavior>` matching `conformance:*` under `#[cfg(any(test, feature="conformance"))]`, a `#[cfg(...)] pub mod conformance` with a unit struct + `pub static` + trait impl, and a `#[cfg(test)] mod tests`. Copy this shape exactly.
- **The projection** the `test` reads is `CampaignView` (`crate::world::mechanics::CampaignView`): `{ round: i64, max_rounds: i64, party: Vec<CharacterView>, rooms: Vec<RoomView> }`, built by `World::build_campaign_view(cat)`. **`rooms` is always empty in v1** — the conformance predicate reads only `round`.
- **`CampaignOutcome`** (`crate::presentation`) is `Ongoing|Won|Lost|TimedOut|Ended` (kebab-case serde). **`OutcomeNarration`** (`crate::presentation`) is `{ text?: String, sound?: Value }` (camelCase, `skip_serializing_if` on both). **`PresentationCue::Resolution { outcome, reason?, narration? }`** already exists — no cue change.
- **Test helper** `crate::world::test_support::world_with_party(&["pc"], max_rounds)` builds a started World (round 0, outcome Ongoing, `actions_per_round == 2`, empty conditions). `cid("pc")` = `CharacterId("pc".into())`.
- **Fixtures** live in `conformance/`. A generator (`conformance/fixtures/<name>.gen.test.ts`) drives the TS oracle and writes `<name>.start.snapshot.json`, `<name>.catalog.json`, `<name>.golden.json` (`{ seed, commands, steps:[{command,cues,snapshot,view}] }`). A replay harness (`conformance/<name>.test.ts`) loads them, calls `wasm.replay_commands(start, JSON.stringify(golden.commands), catalog, golden.seed)`, and compares each step's `cues`/`snapshot`/`view` via `canonicalize(...)`. Generators are excluded from the replay gate. The shared helpers are `conformance/fixtures/gen-helpers.ts` (`structuralClone`, `viewProjected`), `conformance/seeded-rng.ts` (`mulberry32`).

---

### Task 1: `victory.rs` — behavior trait, registry, conformance predicate

**Files:**
- Create: `crates/wickedways-core/src/world/victory.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs:21` (add `pub mod victory;`)

**Interfaces:**
- Produces: `pub trait VictoryConditionBehavior: Sync { fn test(&self, campaign: &CampaignView) -> bool; }`; `pub fn victory_behavior(key: &str) -> Option<&'static dyn VictoryConditionBehavior>`; `pub mod conformance` with `pub const THRESHOLD: i64 = 2`, `pub fn round_reached(round: i64) -> bool`, `pub static ROUND_REACHED`.
- Consumes: `crate::world::mechanics::CampaignView`.

- [ ] **Step 1: Create the file with the trait, registry, conformance impl, and its tests**

Create `crates/wickedways-core/src/world/victory.rs`:

```rust
//! Victory-condition behaviors: a native `VictoryConditionBehavior` trait
//! resolved by `behavior_key` (mirrors `exit_behavior` / `scene_behavior`).
//! Behavior is compiled-in; only `{ key, narration? }` serialize. Byte-exact
//! port of the TS `VictoryCondition.test` predicate (resolved from the registry
//! by key at round-end).
use crate::world::mechanics::CampaignView;

/// A first-party victory condition. Reads the campaign projection and returns
/// whether the condition holds this round (TS `VictoryCondition.test`).
pub trait VictoryConditionBehavior: Sync {
    fn test(&self, campaign: &CampaignView) -> bool;
}

/// Resolve a first-party victory condition by key. `None` for an unregistered
/// key (surfaced as a `ProceduralViolation` at the round-end evaluation site).
pub fn victory_behavior(key: &str) -> Option<&'static dyn VictoryConditionBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:round-reached" {
        return Some(&conformance::ROUND_REACHED);
    }
    let _ = key;
    None
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;

    /// The round at (or after) which `conformance:round-reached` fires.
    pub const THRESHOLD: i64 = 2;

    /// Threshold-logic free helper (testable without a `CampaignView`).
    pub fn round_reached(round: i64) -> bool {
        round >= THRESHOLD
    }

    pub struct RoundReached;
    pub static ROUND_REACHED: RoundReached = RoundReached;

    impl VictoryConditionBehavior for RoundReached {
        fn test(&self, campaign: &CampaignView) -> bool {
            round_reached(campaign.round)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_round_reached_and_rejects_unknown() {
        assert!(victory_behavior("conformance:round-reached").is_some());
        assert!(victory_behavior("nope").is_none());
    }

    #[test]
    fn round_reached_fires_at_or_after_threshold() {
        assert!(!conformance::round_reached(0));
        assert!(!conformance::round_reached(1));
        assert!(conformance::round_reached(2));
        assert!(conformance::round_reached(3));
    }
}
```

- [ ] **Step 2: Register the module**

In `crates/wickedways-core/src/world/mod.rs`, add after `pub mod view;` (line 21):

```rust
pub mod victory;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test -p wickedways-core victory::`
Expected: PASS (`registry_resolves_round_reached_and_rejects_unknown`, `round_reached_fires_at_or_after_threshold`).

- [ ] **Step 4: Verify `no_std` still builds (conformance behavior is cfg-gated)**

Run: `cargo build -p wickedways-core --no-default-features`
Expected: builds clean (the `conformance` mod is absent from the default build).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/victory.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): victory_behavior registry + conformance:round-reached (7)"
```

---

### Task 2: Typed victory snapshot fields

**Files:**
- Modify: `crates/wickedways-core/src/world/snapshot.rs:154-186` (`CampaignCoreSnapshot`; add `VictoryConditionSnapshot`)
- Modify: `crates/wickedways-core/src/world/test_support.rs:62-63` and `:185-186` (two `CampaignCoreSnapshot` literals)
- Test: `crates/wickedways-core/src/world/snapshot.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub struct VictoryConditionSnapshot { pub key: String, pub narration: Option<OutcomeNarration> }`; `CampaignCoreSnapshot.win_conditions: Vec<VictoryConditionSnapshot>`, `.lose_conditions: Vec<VictoryConditionSnapshot>`, `.timeout_narration: Option<OutcomeNarration>`, `.ended_narration: Option<OutcomeNarration>`.
- Consumes: `crate::presentation::OutcomeNarration`.

- [ ] **Step 1: Write the failing round-trip test**

Add to the `#[cfg(test)] mod tests` in `crates/wickedways-core/src/world/snapshot.rs` (the `roundtrip::<T>(json)` helper already exists at the top of that module):

```rust
#[test]
fn victory_condition_snapshot_roundtrips() {
    roundtrip::<VictoryConditionSnapshot>(
        r#"{"key":"conformance:round-reached","narration":{"text":"You win."}}"#,
    );
    // narration omitted when absent (skip_serializing_if)
    roundtrip::<VictoryConditionSnapshot>(r#"{"key":"party-wiped"}"#);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p wickedways-core victory_condition_snapshot_roundtrips`
Expected: FAIL to compile — `VictoryConditionSnapshot` does not exist yet.

- [ ] **Step 3: Add the struct and re-type the four fields**

In `crates/wickedways-core/src/world/snapshot.rs`, add this struct immediately above `pub struct CampaignCoreSnapshot`:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VictoryConditionSnapshot {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narration: Option<crate::presentation::OutcomeNarration>,
}
```

Then replace the four field declarations (currently lines 165-171) — remove the `/// Inert here …` comment — with:

```rust
    pub win_conditions: Vec<VictoryConditionSnapshot>,
    pub lose_conditions: Vec<VictoryConditionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_narration: Option<crate::presentation::OutcomeNarration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_narration: Option<crate::presentation::OutcomeNarration>,
```

(`win_conditions`/`lose_conditions` stay required, no `#[serde(default)]` — existing snapshots always emit `winConditions`/`loseConditions` as arrays.)

- [ ] **Step 4: Fix the two test-helper construction sites**

In `crates/wickedways-core/src/world/test_support.rs`, both `CampaignCoreSnapshot { … }` literals set `win_conditions: Value::Array(vec![])` / `lose_conditions: Value::Array(vec![])`. Change **both** occurrences to:

```rust
        win_conditions: alloc::vec::Vec::new(),
        lose_conditions: alloc::vec::Vec::new(),
```

(Leave `timeout_narration: None` / `ended_narration: None` unchanged.)

- [ ] **Step 5: Run the round-trip test + the existing snapshot round-trip**

Run: `cargo test -p wickedways-core snapshot::`
Expected: PASS — `victory_condition_snapshot_roundtrips` passes AND the existing `full_campaign_snapshot_roundtrips` still passes (its JSON has `"winConditions":[],"loseConditions":[]`, which deserialize into empty `Vec`s and re-serialize identically).

- [ ] **Step 6: Confirm the whole crate compiles (types propagate)**

Run: `cargo test -p wickedways-core --no-run` then `cargo build -p wickedways-core --no-default-features`
Expected: both build clean.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/snapshot.rs crates/wickedways-core/src/world/test_support.rs
git commit -m "feat(core): typed VictoryConditionSnapshot + narration snapshot fields (7)"
```

---

### Task 3: `resolve_outcome` + narration derivation + `end_round` hook

**Files:**
- Modify: `crates/wickedways-core/src/world/turn.rs` (imports; `end_round` body at 184-195; `finish` at 197-202; add `resolve_outcome`, `outcome_narration`, `narration_for`)
- Test: `crates/wickedways-core/src/world/turn.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `crate::world::victory::victory_behavior` (Task 1); `CampaignCoreSnapshot.win_conditions`/`lose_conditions`/`timeout_narration`/`ended_narration` (Task 2); `crate::world::snapshot::VictoryConditionSnapshot`; `crate::presentation::OutcomeNarration`.
- Produces: private `World::resolve_outcome(&self, cat) -> Result<(CampaignOutcome, Option<String>), ProceduralViolation>`; `World::outcome_narration(&self) -> Option<OutcomeNarration>`; associated `World::narration_for(list, reason)`.

- [ ] **Step 1: Add imports**

At the top of `crates/wickedways-core/src/world/turn.rs`, add:

```rust
use alloc::string::String;
use crate::presentation::OutcomeNarration;
use crate::world::snapshot::VictoryConditionSnapshot;
use crate::world::victory::victory_behavior;
```

- [ ] **Step 2: Write the failing tests**

Add these to the `#[cfg(test)] mod tests` in `turn.rs` (helpers `cid`, `world_with_party`, `Catalog` are already imported there):

```rust
    fn vc(key: &str, text: Option<&str>) -> VictoryConditionSnapshot {
        VictoryConditionSnapshot {
            key: key.into(),
            narration: text.map(|t| OutcomeNarration { text: Some(t.into()), sound: None }),
        }
    }

    #[test]
    fn end_round_resolves_won_with_narration() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.round = 1; // → increments to 2, threshold met, ceiling far
        w.campaign.acted_this_round = vec![cid("pc")];
        w.campaign.win_conditions.push(vc("conformance:round-reached", Some("You win.")));
        let mut cues = Vec::new();
        w.end_round(&Catalog::default(), &mut cues).unwrap();
        assert_eq!(w.campaign.outcome, CampaignOutcome::Won);
        assert_eq!(w.campaign.outcome_reason.as_deref(), Some("conformance:round-reached"));
        assert_eq!(cues, vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::Won,
            reason: Some("conformance:round-reached".into()),
            narration: Some(OutcomeNarration { text: Some("You win.".into()), sound: None }),
        }]);
    }

    #[test]
    fn end_round_lose_precedes_win() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.round = 1;
        w.campaign.acted_this_round = vec![cid("pc")];
        w.campaign.win_conditions.push(vc("conformance:round-reached", Some("win")));
        w.campaign.lose_conditions.push(vc("conformance:round-reached", Some("lose")));
        let mut cues = Vec::new();
        w.end_round(&Catalog::default(), &mut cues).unwrap();
        assert_eq!(w.campaign.outcome, CampaignOutcome::Lost);
        assert_eq!(cues, vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::Lost,
            reason: Some("conformance:round-reached".into()),
            narration: Some(OutcomeNarration { text: Some("lose".into()), sound: None }),
        }]);
    }

    #[test]
    fn win_on_final_round_beats_timeout() {
        let mut w = world_with_party(&["pc"], 2); // ceiling 2
        w.campaign.round = 1; // → 2 == max_rounds
        w.campaign.acted_this_round = vec![cid("pc")];
        w.campaign.win_conditions.push(vc("conformance:round-reached", None));
        let mut cues = Vec::new();
        w.end_round(&Catalog::default(), &mut cues).unwrap();
        // 2 >= max_rounds would time out, but the win list is checked first.
        assert_eq!(w.campaign.outcome, CampaignOutcome::Won);
    }

    #[test]
    fn timeout_derives_timeout_narration() {
        let mut w = world_with_party(&["pc"], 1); // round 0 → 1 == max
        w.campaign.timeout_narration =
            Some(OutcomeNarration { text: Some("Time's up.".into()), sound: None });
        w.campaign.acted_this_round = vec![cid("pc")];
        let mut cues = Vec::new();
        w.end_round(&Catalog::default(), &mut cues).unwrap();
        assert_eq!(cues, vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::TimedOut,
            reason: None,
            narration: Some(OutcomeNarration { text: Some("Time's up.".into()), sound: None }),
        }]);
    }
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test -p wickedways-core turn::tests::end_round_resolves_won_with_narration turn::tests::end_round_lose_precedes_win turn::tests::win_on_final_round_beats_timeout turn::tests::timeout_derives_timeout_narration`
Expected: FAIL — `won`/`lost` never resolve (stub is timeout-only) and narration is `None`.

- [ ] **Step 4: Add the resolver + narration derivation and rewrite the `end_round` tail**

In `turn.rs`, replace the timeout-only stub inside `end_round` (currently lines 188-193, from the `// Minimal resolver` comment through the `dispatch_round(RoundPhase::Start …)` fallthrough) so the method tail reads:

```rust
        // onRoundEnd fires BEFORE the round increment (TS fire-point order).
        self.dispatch_round(RoundPhase::End, cat, cues)?;
        self.campaign.round += 1;
        self.campaign.acted_this_round.clear();
        // Full resolver (TS resolveOutcome): loss list → win list → timeout.
        // The terminal path must NOT fire onRoundStart.
        let (outcome, reason) = self.resolve_outcome(cat)?;
        if outcome != CampaignOutcome::Ongoing {
            self.finish(outcome, reason, cues);
            return Ok(());
        }
        self.dispatch_round(RoundPhase::Start, cat, cues)
```

Replace `finish` (lines 197-202) and add the resolver + narration helpers (place them alongside `finish`, before `assert_running`):

```rust
    /// Byte-exact port of TS `resolveOutcome` (victory.ts:46-63). Runs AFTER the
    /// round increment, so `campaign.round` is current. Order: loss list, then
    /// win list, then the `round >= max_rounds` ceiling, then ongoing.
    fn resolve_outcome(
        &self,
        cat: &Catalog,
    ) -> Result<(CampaignOutcome, Option<String>), ProceduralViolation> {
        let view = self.build_campaign_view(cat);
        for c in &self.campaign.lose_conditions {
            let b = victory_behavior(&c.key).ok_or_else(|| {
                ProceduralViolation(format!("No condition registered for key '{}'.", c.key))
            })?;
            if b.test(&view) {
                return Ok((CampaignOutcome::Lost, Some(c.key.clone())));
            }
        }
        for c in &self.campaign.win_conditions {
            let b = victory_behavior(&c.key).ok_or_else(|| {
                ProceduralViolation(format!("No condition registered for key '{}'.", c.key))
            })?;
            if b.test(&view) {
                return Ok((CampaignOutcome::Won, Some(c.key.clone())));
            }
        }
        if self.campaign.round >= self.campaign.max_rounds {
            return Ok((CampaignOutcome::TimedOut, None));
        }
        Ok((CampaignOutcome::Ongoing, None))
    }

    fn finish(&mut self, outcome: CampaignOutcome, reason: Option<String>,
              cues: &mut Vec<PresentationCue>) {
        self.campaign.outcome = outcome;
        self.campaign.outcome_reason = reason.clone();
        let narration = self.outcome_narration();
        cues.push(PresentationCue::Resolution { outcome, reason, narration });
    }

    /// TS `Campaign.outcomeNarration` getter (campaign.ts:275-289): derived from
    /// the just-set `outcome`/`outcome_reason`.
    fn outcome_narration(&self) -> Option<OutcomeNarration> {
        match self.campaign.outcome {
            CampaignOutcome::TimedOut => self.campaign.timeout_narration.clone(),
            CampaignOutcome::Ended => self.campaign.ended_narration.clone(),
            CampaignOutcome::Won => {
                Self::narration_for(&self.campaign.win_conditions,
                                    self.campaign.outcome_reason.as_deref())
            }
            CampaignOutcome::Lost => {
                Self::narration_for(&self.campaign.lose_conditions,
                                    self.campaign.outcome_reason.as_deref())
            }
            CampaignOutcome::Ongoing => None,
        }
    }

    fn narration_for(list: &[VictoryConditionSnapshot], reason: Option<&str>)
        -> Option<OutcomeNarration> {
        let reason = reason?;
        list.iter().find(|c| c.key.as_str() == reason).and_then(|c| c.narration.clone())
    }
```

- [ ] **Step 5: Run the new tests + the full turn suite (regression)**

Run: `cargo test -p wickedways-core turn::`
Expected: PASS — the four new tests plus every existing `turn::tests::*` (including `timeout_at_max_rounds_finishes_and_emits_resolution` and `end_round_terminal_timeout_fires_end_but_not_start`, which still see `narration: None` because `timeout_narration` defaults to `None`).

- [ ] **Step 6: Confirm `no_std` build**

Run: `cargo build -p wickedways-core --no-default-features`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/turn.rs
git commit -m "feat(core): round-end resolveOutcome + narration derivation (7)"
```

---

### Task 4: Manual end — `end_campaign` + `Command::EndCampaign`

**Files:**
- Modify: `crates/wickedways-core/src/world/turn.rs` (add `pub fn end_campaign`)
- Modify: `crates/wickedways-core/src/world/command.rs:14-35` (add `EndCampaign` variant) and `:45-77` (dispatch)
- Test: `turn.rs` and `command.rs` test modules

**Interfaces:**
- Produces: `pub fn World::end_campaign(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`; `Command::EndCampaign` (serde tag `"endCampaign"`).
- Consumes: `finish`/`assert_running`/`outcome_narration` (Task 3).

- [ ] **Step 1: Write the failing `end_campaign` tests (turn.rs)**

Add to `turn.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn end_campaign_finishes_ended_with_narration() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.ended_narration =
            Some(OutcomeNarration { text: Some("You leave.".into()), sound: None });
        let mut cues = Vec::new();
        w.end_campaign(&mut cues).unwrap();
        assert_eq!(w.campaign.outcome, CampaignOutcome::Ended);
        assert_eq!(w.campaign.outcome_reason, None);
        assert_eq!(cues, vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::Ended,
            reason: None,
            narration: Some(OutcomeNarration { text: Some("You leave.".into()), sound: None }),
        }]);
    }

    #[test]
    fn end_campaign_twice_is_a_violation() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.end_campaign(&mut cues).unwrap();
        assert!(w.end_campaign(&mut cues).is_err()); // assert_running blocks once ended
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core turn::tests::end_campaign`
Expected: FAIL to compile — `end_campaign` does not exist.

- [ ] **Step 3: Implement `end_campaign`**

In `turn.rs`, add (next to `end_round`, inside `impl World`):

```rust
    /// TS `Campaign.endCampaign` (campaign.ts:466-469): the manual, GM-neutral
    /// end. Produces the `ended` outcome (no firing condition → `ended_narration`).
    pub fn end_campaign(&mut self, cues: &mut Vec<PresentationCue>)
        -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        self.finish(CampaignOutcome::Ended, None, cues);
        Ok(())
    }
```

- [ ] **Step 4: Run the turn tests**

Run: `cargo test -p wickedways-core turn::tests::end_campaign`
Expected: PASS.

- [ ] **Step 5: Write the failing command deserialize test (command.rs)**

Add to `command.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn end_campaign_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "endCampaign" })
        ).unwrap();
        assert!(matches!(c, Command::EndCampaign));
    }
```

- [ ] **Step 6: Run to verify failure**

Run: `cargo test -p wickedways-core command::tests::end_campaign_deserializes_from_json`
Expected: FAIL to compile — `Command::EndCampaign` does not exist.

- [ ] **Step 7: Add the variant + dispatch**

In `command.rs`, add the variant to the `Command` enum (after `NextPlayer,`, line 17):

```rust
    EndCampaign,
```

And add the dispatch arm in `apply_command`'s `match cmd` (after the `Command::NextPlayer => …` arm, line 49):

```rust
        Command::EndCampaign => world.end_campaign(cues),
```

- [ ] **Step 8: Run the command tests + full crate suite**

Run: `cargo test -p wickedways-core command:: && cargo test -p wickedways-core`
Expected: PASS (new deserialize test + all existing tests).

- [ ] **Step 9: `no_std` build**

Run: `cargo build -p wickedways-core --no-default-features`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add crates/wickedways-core/src/world/turn.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): end_campaign + Command::EndCampaign manual-end path (7)"
```

---

### Task 5: Shadow + `victory-won` & `victory-lost` differential fixtures

**Files:**
- Create: `conformance/fixtures/victory-shadow.ts`
- Create: `conformance/fixtures/victory-won.gen.test.ts`, `conformance/victory-won.test.ts`
- Create: `conformance/fixtures/victory-lost.gen.test.ts`, `conformance/victory-lost.test.ts`
- Generated (committed): `conformance/fixtures/victory-won.{start.snapshot,catalog,golden}.json`, `conformance/fixtures/victory-lost.{start.snapshot,catalog,golden}.json`

**Interfaces:**
- Consumes: Tasks 1-3 (Rust replay resolves `conformance:round-reached`, derives narration); `buildSeedRegistry`, `authorTemplate`, `startSession`, `serializeCampaign`, `mulberry32`, `viewProjected`.
- Produces: `ROUND_REACHED_KEY`, `roundReached` (shadow) for reuse by Task 6.

**Context:** These are **two-player** campaigns (Ada + Ben, `gm: 0`), matching the proven `turn-movement` setup, so `startSession` validation is satisfied and one round takes two `nextPlayer` calls. Threshold is 2 and `maxRounds` is 10 (ceiling far), so the win/lose fires at round 2 (after 4 `nextPlayer`), distinctly from timeout. The stream draws no rng. `nextPlayer` needs no prior `startTurn` (it only marks the actor acted and advances), so the stream is bare `nextPlayer` calls.

- [ ] **Step 1: Create the shadow**

Create `conformance/fixtures/victory-shadow.ts`:

```ts
/**
 * The `conformance:round-reached` victory condition — a TS "shadow" reproducing
 * the Rust `conformance::ROUND_REACHED` behavior byte-for-byte
 * (crates/wickedways-core/src/world/victory.rs): fires when the (post-increment)
 * round has reached THRESHOLD (2).
 *
 * Shared by every victory conformance generator so the shadow cannot drift.
 */
import type { ICampaign } from "wickedways/lib/campaign";

export const ROUND_REACHED_KEY = "conformance:round-reached";

/** THRESHOLD = 2, matching Rust `conformance::THRESHOLD`. */
export const roundReached = (campaign: ICampaign): boolean => campaign.round >= 2;
```

- [ ] **Step 2: Create the `victory-won` generator**

Create `conformance/fixtures/victory-won.gen.test.ts`:

```ts
/**
 * victory-won golden generator — run once to write the committed fixture files.
 *
 * Two-player bespoke campaign (Ada + Ben, gm 0) with a registered win condition
 * `conformance:round-reached` (fires at round >= 2). maxRounds 10 keeps the
 * timeout ceiling far, so the win fires on its own predicate at round 2, NOT via
 * the ceiling. Command stream: 4× nextPlayer (round 0→1 ongoing, 1→2 → won).
 *
 * Draws NO rng (no formations, healthy PCs, no combat, no movement), so any seed
 * yields the same golden.
 *
 * Writes:
 *   - victory-won.start.snapshot.json
 *   - victory-won.catalog.json  (empty)
 *   - victory-won.golden.json   ({ seed, commands, steps })
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedRegistry } from "../../packages/seed/src/index.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { PresentationCue } from "wickedways/lib/presentation";
import { mulberry32 } from "../seeded-rng.ts";
import { viewProjected } from "./gen-helpers.ts";
import { ROUND_REACHED_KEY, roundReached } from "./victory-shadow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x7e57;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "nextPlayer" };

describe("generate victory-won golden", () => {
  it("writes the booted snapshot + per-step golden (won at round 2)", () => {
    const registry = buildSeedRegistry();
    registry.registerCondition(ROUND_REACHED_KEY, roundReached);

    const template = authorTemplate("Victory Won (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 10,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .winWhen(ROUND_REACHED_KEY, { text: "You win." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    if (campaign.round !== 0) throw new Error(`expected round 0, got ${campaign.round}`);
    if (campaign.maxRounds !== 10) throw new Error(`expected maxRounds 10, got ${campaign.maxRounds}`);

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-won.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    // 2 players → 2 nextPlayer per round; 4 total reach round 2.
    const commands: Command[] = [
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 1 (ongoing)
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 2 (won)
    ];
    const steps = commands.map((cmd) => {
      campaign.nextPlayer();
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    // Coverage: the final step must carry a resolution cue with outcome "won".
    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "won")
      throw new Error(`expected outcome "won", got "${res.outcome}"`);
    if (campaign.outcome !== "won") throw new Error(`expected campaign.outcome "won", got "${campaign.outcome}"`);

    writeFileSync(join(here, "victory-won.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-won.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
```

- [ ] **Step 3: Create the `victory-won` replay harness**

Create `conformance/victory-won.test.ts`:

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

const start = readFileSync(join(here, "fixtures/victory-won.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/victory-won.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/victory-won.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("victory-won differential conformance", () => {
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

- [ ] **Step 4: Create the `victory-lost` generator**

Create `conformance/fixtures/victory-lost.gen.test.ts` — identical to `victory-won.gen.test.ts` except: the `describe`/`it`/title strings, the SEED, the fixture basenames, and the conditions (the **same key** in both lists, distinct narration). Full file:

```ts
/**
 * victory-lost golden generator — run once to write the committed fixture files.
 *
 * Same as victory-won but the SAME key `conformance:round-reached` is placed in
 * BOTH the win list (.winWhen) and the lose list (.loseWhen), with distinct
 * per-list narration. At round 2 both fire; resolveOutcome checks the loss list
 * first → outcome "lost" with the LOSE narration. Proves lose-before-win.
 *
 * Writes victory-lost.{start.snapshot,catalog,golden}.json.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedRegistry } from "../../packages/seed/src/index.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { PresentationCue } from "wickedways/lib/presentation";
import { mulberry32 } from "../seeded-rng.ts";
import { viewProjected } from "./gen-helpers.ts";
import { ROUND_REACHED_KEY, roundReached } from "./victory-shadow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x105e;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "nextPlayer" };

describe("generate victory-lost golden", () => {
  it("writes the booted snapshot + per-step golden (lost via precedence)", () => {
    const registry = buildSeedRegistry();
    registry.registerCondition(ROUND_REACHED_KEY, roundReached);

    const template = authorTemplate("Victory Lost (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 10,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .winWhen(ROUND_REACHED_KEY, { text: "win" })
      .loseWhen(ROUND_REACHED_KEY, { text: "lose" });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    if (campaign.round !== 0) throw new Error(`expected round 0, got ${campaign.round}`);

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-lost.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      { kind: "nextPlayer" }, { kind: "nextPlayer" },
      { kind: "nextPlayer" }, { kind: "nextPlayer" },
    ];
    const steps = commands.map((cmd) => {
      campaign.nextPlayer();
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "lost")
      throw new Error(`expected outcome "lost", got "${res.outcome}"`);
    if (res.kind === "resolution" && (res.narration?.text !== "lose"))
      throw new Error(`expected LOSE narration, got ${JSON.stringify(res.narration)}`);
    if (campaign.outcome !== "lost") throw new Error(`expected campaign.outcome "lost", got "${campaign.outcome}"`);

    writeFileSync(join(here, "victory-lost.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-lost.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
```

- [ ] **Step 5: Create the `victory-lost` replay harness**

Create `conformance/victory-lost.test.ts` — identical to `victory-won.test.ts` but every `victory-won` basename becomes `victory-lost` and the `describe` string is `"victory-lost differential conformance"`. Full file:

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

const start = readFileSync(join(here, "fixtures/victory-lost.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/victory-lost.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/victory-lost.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("victory-lost differential conformance", () => {
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

- [ ] **Step 6: Generate the goldens**

Run: `pnpm run fixtures:gen`
Expected: all generators pass; the four new `victory-won.*` / `victory-lost.*` fixture files appear under `conformance/fixtures/`. (`git status --short conformance/fixtures` should show ONLY the new `victory-won.*` and `victory-lost.*` files plus the two new `.gen.test.ts` and `victory-shadow.ts` — no other golden churn.)

- [ ] **Step 7: Run the differential replay (builds wasm)**

Run: `pnpm run test:conformance`
Expected: PASS — `victory-won` and `victory-lost` replays match per step, and every existing conformance fixture (incl. `turn-movement`) stays green.

- [ ] **Step 8: Commit**

```bash
git add conformance/fixtures/victory-shadow.ts \
  conformance/fixtures/victory-won.gen.test.ts conformance/victory-won.test.ts \
  conformance/fixtures/victory-won.start.snapshot.json conformance/fixtures/victory-won.catalog.json conformance/fixtures/victory-won.golden.json \
  conformance/fixtures/victory-lost.gen.test.ts conformance/victory-lost.test.ts \
  conformance/fixtures/victory-lost.start.snapshot.json conformance/fixtures/victory-lost.catalog.json conformance/fixtures/victory-lost.golden.json
git commit -m "test(conformance): victory won + lost (precedence) differential fixtures (7)"
```

- [ ] **Step 9: Verify regeneration is byte-stable (post-commit)**

Run: `pnpm run fixtures:stable`
Expected: EXIT 0 (regeneration produces no diff against the committed goldens).

---

### Task 6: `victory-timeout` & `victory-ended` fixtures + docs

**Files:**
- Create: `conformance/fixtures/victory-timeout.gen.test.ts`, `conformance/victory-timeout.test.ts`
- Create: `conformance/fixtures/victory-ended.gen.test.ts`, `conformance/victory-ended.test.ts`
- Generated (committed): `victory-timeout.*`, `victory-ended.*` fixture JSON
- Modify: `README.md` (victory-conditions note)

**Interfaces:**
- Consumes: Task 4 (`Command::EndCampaign` / `campaign.endCampaign()`), Task 3 (timeout/ended narration derivation).

- [ ] **Step 1: Create the `victory-timeout` generator**

Create `conformance/fixtures/victory-timeout.gen.test.ts`:

```ts
/**
 * victory-timeout golden generator — run once to write the committed fixtures.
 *
 * Two-player campaign with NO win/lose conditions, maxRounds 2, and a timeout
 * narration (.onTimeout). Command stream 4× nextPlayer: round 0→1 (ongoing,
 * 1<2), 1→2 (round 2 == maxRounds, no condition → timed-out with the timeout
 * narration on the cue).
 *
 * Writes victory-timeout.{start.snapshot,catalog,golden}.json.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedRegistry } from "../../packages/seed/src/index.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { PresentationCue } from "wickedways/lib/presentation";
import { mulberry32 } from "../seeded-rng.ts";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x7104;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "nextPlayer" };

describe("generate victory-timeout golden", () => {
  it("writes the booted snapshot + per-step golden (timed-out at maxRounds)", () => {
    const registry = buildSeedRegistry();

    const template = authorTemplate("Victory Timeout (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 2,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .onTimeout({ text: "Time's up." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    if (campaign.maxRounds !== 2) throw new Error(`expected maxRounds 2, got ${campaign.maxRounds}`);

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-timeout.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 1 (ongoing)
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 2 == max (timed-out)
    ];
    const steps = commands.map((cmd) => {
      campaign.nextPlayer();
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "timed-out")
      throw new Error(`expected outcome "timed-out", got "${res.outcome}"`);
    if (res.kind === "resolution" && res.narration?.text !== "Time's up.")
      throw new Error(`expected timeout narration, got ${JSON.stringify(res.narration)}`);

    writeFileSync(join(here, "victory-timeout.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-timeout.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
```

- [ ] **Step 2: Create the `victory-timeout` replay harness**

Create `conformance/victory-timeout.test.ts` — identical to `victory-won.test.ts` with every `victory-won` basename replaced by `victory-timeout` and the `describe` string `"victory-timeout differential conformance"`:

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

const start = readFileSync(join(here, "fixtures/victory-timeout.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/victory-timeout.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/victory-timeout.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("victory-timeout differential conformance", () => {
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

- [ ] **Step 3: Create the `victory-ended` generator**

Create `conformance/fixtures/victory-ended.gen.test.ts`. Note its `Command` union adds `endCampaign`, and the driver calls `campaign.endCampaign()` for it:

```ts
/**
 * victory-ended golden generator — run once to write the committed fixtures.
 *
 * Two-player campaign with an .onEnd fallback narration. A single `endCampaign`
 * command at round 0 → manual "ended" outcome with the ended narration on the
 * cue. Exercises Command::EndCampaign on the Rust replay side.
 *
 * Writes victory-ended.{start.snapshot,catalog,golden}.json.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedRegistry } from "../../packages/seed/src/index.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { PresentationCue } from "wickedways/lib/presentation";
import { mulberry32 } from "../seeded-rng.ts";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xe4de;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "endCampaign" };

describe("generate victory-ended golden", () => {
  it("writes the booted snapshot + per-step golden (manual ended)", () => {
    const registry = buildSeedRegistry();

    const template = authorTemplate("Victory Ended (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 10,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .onEnd({ text: "You leave." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-ended.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [{ kind: "endCampaign" }];
    const steps = commands.map((cmd) => {
      campaign.endCampaign();
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "ended")
      throw new Error(`expected outcome "ended", got "${res.outcome}"`);
    if (res.kind === "resolution" && res.narration?.text !== "You leave.")
      throw new Error(`expected ended narration, got ${JSON.stringify(res.narration)}`);

    writeFileSync(join(here, "victory-ended.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-ended.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
```

- [ ] **Step 4: Create the `victory-ended` replay harness**

Create `conformance/victory-ended.test.ts` — identical to `victory-won.test.ts` with the basename `victory-ended` and the `describe` string `"victory-ended differential conformance"`:

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

const start = readFileSync(join(here, "fixtures/victory-ended.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/victory-ended.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/victory-ended.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("victory-ended differential conformance", () => {
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

- [ ] **Step 5: Generate the goldens**

Run: `pnpm run fixtures:gen`
Expected: all pass; new `victory-timeout.*` and `victory-ended.*` files appear. `git status --short conformance/fixtures` shows ONLY the new files (no churn of prior goldens).

- [ ] **Step 6: Add the README note**

In `README.md`, find the victory-conditions section (search `Victory` / `outcome`). Add a sentence noting the Rust core now honors it — e.g. under that section:

> The Rust engine core (`crates/wickedways-core`) mirrors this: round-end evaluation resolves `won` / `lost` / `timed-out` (loss conditions before win, then the `maxRounds` ceiling) and the manual `endCampaign()` resolves `ended`, each emitting the same `resolution` cue with the authored outcome narration.

- [ ] **Step 7: Run the full gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 — `no_std` build + `cargo test --workspace` + bindings check + `test:conformance` (all six victory-related replays plus every prior fixture green, `turn-movement` unchanged).

- [ ] **Step 8: Commit**

```bash
git add conformance/fixtures/victory-timeout.gen.test.ts conformance/victory-timeout.test.ts \
  conformance/fixtures/victory-timeout.start.snapshot.json conformance/fixtures/victory-timeout.catalog.json conformance/fixtures/victory-timeout.golden.json \
  conformance/fixtures/victory-ended.gen.test.ts conformance/victory-ended.test.ts \
  conformance/fixtures/victory-ended.start.snapshot.json conformance/fixtures/victory-ended.catalog.json conformance/fixtures/victory-ended.golden.json \
  README.md
git commit -m "test(conformance): victory timeout + ended fixtures; README note (7)"
```

- [ ] **Step 9: Verify regeneration is byte-stable (post-commit)**

Run: `pnpm run fixtures:stable`
Expected: EXIT 0.

---

## Self-Review

**1. Spec coverage** (against `…-subplan-7-victory-conditions-design.md`):

- `victory.rs` trait + `victory_behavior(key)` registry + `conformance:round-reached` → Task 1. ✅
- `pub mod victory;` alpha placement → Task 1 Step 2. ✅
- Typed `VictoryConditionSnapshot` + narration fields, byte-compatible, no schema bump → Task 2. ✅
- `resolve_outcome` (lose→win→timeout order, post-increment) → Task 3. ✅
- `finish` narration derivation (`outcome_narration`/`narration_for`, TS getter order) → Task 3. ✅
- `end_campaign` + `Command::EndCampaign` → Task 4. ✅
- `victory-shadow.ts` + four differential fixtures (won, lost-precedence, timeout, ended) → Tasks 5-6. ✅
- Error handling: unknown key → `ProceduralViolation` at eval (`resolve_outcome`) → Task 3. ✅
- Non-goals honored: no `assert_running` message change, no `endCampaign(outcome)`, no mid-play mutation. ✅
- README note → Task 6 Step 6. ✅
- Gate: `checks:phase3` + `fixtures:stable`, no golden churn, `turn-movement` green → Tasks 5-6. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✅

**3. Type consistency:** `VictoryConditionSnapshot { key, narration }` used identically in Tasks 2-3; `resolve_outcome`/`finish`/`outcome_narration`/`narration_for` signatures consistent; `victory_behavior(key)`, `ROUND_REACHED_KEY`/`roundReached` (shadow), `Command::EndCampaign` (`"endCampaign"` tag) consistent across tasks. Fixture basenames and file paths consistent between each generator and its harness. ✅

## Execution notes

- **Fixture rng rule (carried):** the victory campaigns register **no encounter formation** and issue no `go`, so the command stream draws no rng and any seed reproduces the golden.
- **Two-player campaigns** (`gm: 0`) match the proven `turn-movement` setup; one round = two `nextPlayer` calls. `nextPlayer` requires no prior `startTurn`.
- If a differential fixture RED-flags a divergence, **fix it in Rust source** (Tasks 1-4) — never edit a golden or the comparator.
