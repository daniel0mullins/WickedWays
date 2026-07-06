# Rust Engine — Phase 1, Sub-plan 7: Victory Conditions (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core (`crates/wickedways-core`),
verified byte-for-byte against the TS "oracle" by a differential conformance gate. Sub-plan 7 is the
**final Phase-1 piece**: porting the campaign **victory-condition** system — round-end resolution to an
explicit outcome (`won` / `lost` / `timed-out`), the manual `ended` path, authored outcome narration,
and the `resolution` presentation cue.

The TS feature is fully implemented and shipped (`src/lib/victory.ts` + `campaign.ts`; original design
`docs/superpowers/specs/2026-06-19-victory-conditions-design.md`). Much of the Rust **scaffolding already
exists** — sub-plan 5 landed the round counter, `end_round`, a private `finish`, `assert_running`, the
`CampaignOutcome`/`OutcomeNarration` types, the `PresentationCue::Resolution` variant, and all seven
victory wire-fields on the snapshot (currently inert). What is missing is the **resolver logic**, the
**narration derivation**, the **manual-end command**, and **typed condition state** — plus differential
coverage. This sub-plan fills those in with no new user-facing mechanic.

## Global constraints (carried, verbatim)

- **The differential conformance gate is the authority.** Never edit a golden or
  `conformance/canonical-json.ts` to force a pass. Divergences are fixed in Rust source (or a faithful
  fixture correction).
- **`no_std` core:** `alloc::` only (never `std::`); conformance behaviors stay behind
  `#[cfg(any(test, feature = "conformance"))]`, absent from the default build.
- **Native-registry + matched-TS-shadow pattern:** registry-bound behaviors are compiled-in Rust impls
  keyed by a `behavior_key`; conformance behaviors are cfg-gated native Rust impls + matched TS closure
  "shadows" registered under the shared key, gate-tested via differential fixtures.
- Full gate `pnpm run checks:phase3` EXIT 0 (no_std build + `cargo test --workspace` + bindings check +
  `test:conformance`) + `pnpm run fixtures:stable` EXIT 0 (idempotent regen, run post-commit). No
  unintended golden churn.

## The TS oracle (authoritative behavior being ported)

### `resolveOutcome` (`src/lib/victory.ts:46-63`) — exact order

1. Loop `loseConditions` in order; first `c.test(campaign)` truthy → `{ status: "lost", condition: c }`.
2. Loop `winConditions` in order; first truthy → `{ status: "won", condition: c }`.
3. `if (round >= maxRounds) return { status: "timed-out" }` (no condition).
4. Else `{ status: "ongoing" }`.

**Loss precedes win; timeout fires only if nothing else did.**

### `endRound` (`campaign.ts:478-501`) — exact order

`assertRunning()` → all-party-acted check (else `ProceduralViolation`) → `dispatchRound("onRoundEnd")`
**before** increment → `round += 1` → `resetActivity()` → `resolveOutcome({round, maxRounds, win, lose,
campaign})` → if `status !== "ongoing"` call `finish(status, condition)` and **return** (no
`onRoundStart`) → else `dispatchRound("onRoundStart")`.

### `finish` (`campaign.ts:450-459`) and `endCampaign` (`466-469`)

```
#finish(outcome, condition?) {
  this.#outcome = outcome;
  this.#outcomeReason = condition?.key;
  this[EMIT_CUE]({ kind: "resolution", outcome, reason: condition?.key, narration: this.outcomeNarration });
}
endCampaign() { this.#assertRunning(); this.#finish("ended"); }
```

`outcomeNarration` getter (`campaign.ts:275-289`): `timed-out` → `#timeoutNarration`; `ended` →
`#endedNarration`; `won`/`lost` → `list.find(c => c.key === #outcomeReason)?.narration` (the matching
win/lose list); `ongoing` → `undefined`. **Narration is derived after `#outcome`/`#outcomeReason` are
set**, so the cue carries the resolved prose.

### Registry (`serialization/registry.ts:80-82,125-127`)

`registerCondition(key, predicate)` / `condition(key)`; `condition` throws
`ProceduralViolation("No condition registered for key '<key>'.")` on a miss. The registry **ships empty** —
every condition is author-supplied.

### Serialization (`serialization/types.ts:106-121`, `campaign.ts:894-998`)

`CampaignCoreSnapshot` stores `outcome`, `outcomeReason?`, `winConditions: {key, narration?}[]`,
`loseConditions: {key, narration?}[]`, `timeoutNarration?`, `endedNarration?`, plus `maxRounds`, `round`,
`started`. The `test` predicate is **not serialized** — re-resolved from the registry key on hydrate.
`OutcomeNarration = { text?: string; sound?: AssetRef }`, `AssetRef = string`.

## Current Rust state (what exists to build on)

- `world/turn.rs`: `end_round` (`~174-195`) already does `dispatch_round(End)` before `round += 1` and
  `dispatch_round(Start)` only when ongoing — but the resolver is **timeout-only** (`if round >= max_rounds
  { finish(TimedOut, None) }`, comment "Win/lose -> sub-plan 7"). `finish` (`~197-202`) exists but hard-codes
  `narration: None`. `assert_running` (`~204-209`) uses a single message `"campaign is not running"`.
- `world/command.rs`: `Command` enum has `StartTurn, EndTurn, Go, NextPlayer, Take, Drop, Open, Equip,
  Unequip, Use, Attack, MechanicAction`. **No `EndCampaign`.**
- `world/snapshot.rs` `CampaignCoreSnapshot` (`~154-186`): `max_rounds`, `round`, `started`, `outcome`,
  `outcome_reason`, `acted_this_round`, `active_character_index` are typed and round-trip. But
  `win_conditions`/`lose_conditions` are **inert `serde_json::Value` passthroughs** and
  `timeout_narration`/`ended_narration` are **`Option<Value>`** — no typed condition state, no predicate
  binding.
- `presentation.rs`: `CampaignOutcome` (kebab-case serde), `OutcomeNarration { text?, sound? }`, and
  `PresentationCue::Resolution { outcome, reason?, narration? }` **already exist and serialize identically
  to TS** — no cue change needed.
- `world/mechanics/view.rs`: `CampaignView { round, max_rounds, party: Vec<CharacterView>, rooms:
  Vec<RoomView> }` built by `World::build_campaign_view(cat)`; `CharacterView { id, name, health, sanity,
  energy, status, room_id: Option<String>, … }`; `RoomView { id, name, lit, occupant_ids, occupants }`. This
  is the projection a victory `test` reads — **no view extension required.**

## Architecture

### New unit: `crates/wickedways-core/src/world/victory.rs`

Mirrors `world/exits.rs` and `world/scenes.rs` exactly (the header comment cites "mirrors `mechanic_op`"):

```rust
pub trait VictoryConditionBehavior: Sync {
    fn test(&self, campaign: &CampaignView) -> bool;
}

pub fn victory_behavior(key: &str) -> Option<&'static dyn VictoryConditionBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:reached-goal" { return Some(&conformance::REACHED_GOAL); }
    let _ = key;
    None
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    /// True iff a party member is located in the room named "Goal".
    fn reached_goal(campaign: &CampaignView) -> bool {
        let goal_id = campaign.rooms.iter().find(|r| r.name == "Goal").map(|r| r.id.clone());
        match goal_id {
            Some(id) => campaign.party.iter().any(|c| c.room_id.as_deref() == Some(id.as_str())),
            None => false,
        }
    }
    pub struct ReachedGoal;
    pub static REACHED_GOAL: ReachedGoal = ReachedGoal;
    impl VictoryConditionBehavior for ReachedGoal {
        fn test(&self, campaign: &CampaignView) -> bool { reached_goal(campaign) }
    }
}

#[cfg(test)]
mod tests { /* victory_behavior("conformance:reached-goal").is_some(); ("nope").is_none() */ }
```

**Decision 1 — resolve at eval, not hydrate.** The `test` predicate is resolved by key **at round-end**
(like `exit_behavior`/`scene_behavior` resolve at fire-time), not validated at snapshot-hydrate as TS does
at deserialize. Unknown key → `ProceduralViolation` at the round-end evaluation. The difference is
unobservable through the gate (a fixture never registers an unknown key) and matches every Rust sibling
registry.

**Decision 2 — room-occupancy conformance predicate.** `conformance:reached-goal` reads real game state
(a party member's location) rather than a degenerate `round >= N` (which would overlap timeout semantics).
Its matched TS shadow computes the identical boolean.

### `world/turn.rs` changes

1. **`resolve_outcome`** — new private method, exact TS order:
   ```rust
   fn resolve_outcome(&self, cat: &Catalog)
       -> Result<(CampaignOutcome, Option<String>), ProceduralViolation> {
       let view = self.build_campaign_view(cat); // post-increment: view.round is current
       for c in &self.campaign.lose_conditions {
           let b = victory_behavior(&c.key)
               .ok_or_else(|| ProceduralViolation(format!("No condition registered for key '{}'.", c.key).into()))?;
           if b.test(&view) { return Ok((CampaignOutcome::Lost, Some(c.key.clone()))); }
       }
       for c in &self.campaign.win_conditions {
           let b = victory_behavior(&c.key)
               .ok_or_else(|| ProceduralViolation(format!("No condition registered for key '{}'.", c.key).into()))?;
           if b.test(&view) { return Ok((CampaignOutcome::Won, Some(c.key.clone()))); }
       }
       if self.campaign.round >= self.campaign.max_rounds {
           return Ok((CampaignOutcome::TimedOut, None));
       }
       Ok((CampaignOutcome::Ongoing, None))
   }
   ```
2. **`end_round`** — replace the timeout-only branch (after `round += 1` and `acted_this_round.clear()`)
   with:
   ```rust
   let (outcome, reason) = self.resolve_outcome(cat)?;
   if outcome != CampaignOutcome::Ongoing {
       self.finish(outcome, reason, cues);
       return Ok(());
   }
   self.dispatch_round(RoundPhase::Start, cat, cues)
   ```
   The `dispatch_round(End)`-before-increment ordering already present is preserved.
3. **`finish`** — set outcome+reason first, then derive narration (TS order):
   ```rust
   fn finish(&mut self, outcome, reason, cues) {
       self.campaign.outcome = outcome;
       self.campaign.outcome_reason = reason.clone();
       let narration = self.outcome_narration();
       cues.push(PresentationCue::Resolution { outcome, reason, narration });
   }
   fn outcome_narration(&self) -> Option<OutcomeNarration> {
       match self.campaign.outcome {
           CampaignOutcome::TimedOut => self.campaign.timeout_narration.clone(),
           CampaignOutcome::Ended    => self.campaign.ended_narration.clone(),
           CampaignOutcome::Won  => self.narration_for(&self.campaign.win_conditions),
           CampaignOutcome::Lost => self.narration_for(&self.campaign.lose_conditions),
           CampaignOutcome::Ongoing => None,
       }
   }
   // narration_for: find by key == outcome_reason, clone its narration
   ```
4. **`end_campaign`** — new public method:
   ```rust
   pub fn end_campaign(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
       self.assert_running()?;
       self.finish(CampaignOutcome::Ended, None, cues);
       Ok(())
   }
   ```

### `world/command.rs` change

Add `Command::EndCampaign` and dispatch it in `replay_commands` to `World::end_campaign(cues)`.

### `world/snapshot.rs` change (byte-compatible)

Promote the four inert fields to typed:

```rust
#[derive(Serialize, Deserialize, ...)]
#[serde(rename_all = "camelCase")]
pub struct VictoryConditionSnapshot {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub narration: Option<OutcomeNarration>,
}
// on CampaignCoreSnapshot:
pub win_conditions: Vec<VictoryConditionSnapshot>,
pub lose_conditions: Vec<VictoryConditionSnapshot>,
#[serde(skip_serializing_if = "Option::is_none")] pub timeout_narration: Option<OutcomeNarration>,
#[serde(skip_serializing_if = "Option::is_none")] pub ended_narration: Option<OutcomeNarration>,
```

`OutcomeNarration` (`presentation.rs`) already serializes `{ text?, sound? }` camelCase, and
`VictoryConditionSnapshot` matches the TS `{ key, narration? }`. The wire format is unchanged, so
**existing goldens/start-snapshots do not churn** and **no `SCHEMA_VERSION` bump** is needed (the fields
already existed as `Value`; this only types them). `mod.rs` gains `pub mod victory;` in alpha position.

## Differential fixtures (comprehensive)

Four dedicated fixtures, each a small bespoke campaign proving one `resolveOutcome` branch + its narration.
Each authors conditions/narration via the template builder and registers the matched shadow(s) through
`registry.registerCondition`. A shared `conformance/fixtures/victory-shadow.ts` exports the shadow
predicate(s), logic-matched to the native Rust `test`:

```ts
// victory-shadow.ts — matches conformance::reached_goal
export const reachedGoal = (campaign: ICampaign): boolean =>
  campaign.party.some((c) => c.currentRoom?.name === "Goal");
```

| Fixture | Setup / commands | Asserts (per-step, byte-exact) |
|---|---|---|
| `victory-won` | win `conformance:reached-goal` (+narration), `maxRounds` high; PC moves to "Goal"; `nextPlayer` calls wrap → `end_round` | `resolution` cue `outcome:"won"`, `reason:"conformance:reached-goal"`, the condition's `narration`; snapshot `outcome`/`outcomeReason` |
| `victory-lost` | reference the **same** registry key `conformance:reached-goal` in **both** the win list and the lose list (distinct per-list narration — narration is list-entry content, not registry-bound); PC reaches "Goal" so both fire the same round | `outcome:"lost"` — **proves lose-before-win precedence** — + the **lose** list entry's narration (found by `outcomeReason` in `loseConditions`) |
| `victory-timeout` | no conditions, `maxRounds:2`, `onTimeout` narration set; drive `nextPlayer` to the ceiling | `outcome:"timed-out"`, `reason` absent, `timeoutNarration` on the cue |
| `victory-ended` | `endCampaign` command issued mid-play | `outcome:"ended"`, `reason` absent, `endedNarration` on the cue |

The existing `turn-movement` fixture (20 `nextPlayer` → round 10 → plain, narration-less `timed-out`)
already exercises the timeout path and **must stay green** — the snapshot-typing change must not churn it.

### Fixture rng note (carried rule)

Per the 6c-3 fixture rule, a registered encounter formation offsets the rng stream at the genesis snapshot.
The victory fixtures **register no formation**; movement-only setups keep the stream aligned.

## Error handling

- Unknown condition key at round-end → `ProceduralViolation("No condition registered for key '<key>'.")`
  (mirrors `registry.condition`; sibling-consistent; unreachable through the gate).
- Post-finish commands (`start_turn`, `go`, `next_player`, `end_campaign`, …) already throw via
  `assert_running()` once `outcome != Ongoing` — no change. A throwing command crashes a generator, so no
  golden captures it.
- A `test` predicate is author code, expected total; a panic propagates (TS lets predicate throws escape
  `endRound`). Conformance predicates never panic.

## Non-goals / left as-is

- **`assert_running` message parity:** Rust keeps its single `"campaign is not running"` string; TS emits
  two distinct strings ("Campaign has not begun" / "Campaign has already finished"). Unobservable through
  the gate (throwing commands crash the generator). No change.
- **No `endCampaign(outcome)` GM-declared win/loss** — the manual path stays the single neutral `ended`,
  matching the TS oracle.
- **No mid-play condition-list mutation** — conditions are static construction config, as in TS.
- Carried mob/misc debts from earlier sub-plans (`sees_in_dark` differential coverage, a
  mob-with-equipped-item/key drop fixture, the `deposit_materials` non-numeric-qty one-liner, 6a-3 nits,
  the `sees_in_dark ≡ light_averse` decouple) are **out of scope** for sub-plan 7 — they remain their own
  follow-ups.

## Testing & gate

- **Rust unit tests** (`turn.rs`, `victory.rs`, run under default features): `resolve_outcome`
  lose-before-win precedence; both-fire → lost; win on the final round → won (not timed-out); empty lists +
  ceiling → timed-out; empty lists under ceiling → ongoing; `outcome_narration` derivation for each of
  won/lost/timed-out/ended/ongoing; `victory_behavior` resolve-hit and miss; `end_campaign` → ended cue +
  post-finish `assert_running` block.
- **Differential:** the four `victory-*` fixtures GREEN; `turn-movement` unchanged.
- **`no_std`:** `cargo build -p wickedways-core --no-default-features` clean; conformance behaviors gated.
- **Full gate:** `pnpm run checks:phase3` EXIT 0 + `pnpm run fixtures:stable` EXIT 0 (post-commit), no
  unintended golden churn.

## Documentation

`README.md` already documents victory conditions (the TS mechanic). Add a short note that the Rust core now
honors round-end resolution + the manual end. No new user-facing mechanic. Update relevant Rust doc
comments (`victory.rs`, the new `turn.rs` methods, `VictoryConditionSnapshot`).

## File map

| File | Change |
| --- | --- |
| `crates/wickedways-core/src/world/victory.rs` | **new** — `VictoryConditionBehavior` trait + `victory_behavior(key)` registry + `conformance::REACHED_GOAL` + registry unit tests |
| `crates/wickedways-core/src/world/mod.rs` | `pub mod victory;` (alpha placement) |
| `crates/wickedways-core/src/world/turn.rs` | `resolve_outcome`, `end_round` resolver hook, `finish` narration derivation (`outcome_narration`/`narration_for`), `end_campaign` |
| `crates/wickedways-core/src/world/command.rs` | `Command::EndCampaign` + `replay_commands` dispatch |
| `crates/wickedways-core/src/world/snapshot.rs` | `VictoryConditionSnapshot`; typed `win_conditions`/`lose_conditions`/`timeout_narration`/`ended_narration` (byte-compatible, no schema bump) |
| `conformance/fixtures/victory-shadow.ts` | **new** — matched shadow predicate(s) |
| `conformance/fixtures/victory-won.gen.test.ts` | **new** generator |
| `conformance/fixtures/victory-lost.gen.test.ts` | **new** generator (precedence) |
| `conformance/fixtures/victory-timeout.gen.test.ts` | **new** generator |
| `conformance/fixtures/victory-ended.gen.test.ts` | **new** generator |
| `conformance/victory-won.test.ts` / `victory-lost.test.ts` / `victory-timeout.test.ts` / `victory-ended.test.ts` | **new** replay/diff harnesses |
| `README.md` | note the Rust core now honors victory resolution + manual end |
