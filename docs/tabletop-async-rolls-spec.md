# Async roll-request flow (spec)

> **Status:** design spec, not built. Extends the shipped **dice-supply seam** (a mob d20 to-hit fed by
> `Command::SupplyDice` → `World::draw_die`; see the README "Mob to-hit rolls & the dice-supply seam"
> and [`tabletop-simulator-spec.md`](./tabletop-simulator-spec.md)). This document specs the missing
> half: a **pause-at-the-moment** handshake so the table is prompted to roll *when* a roll is needed,
> instead of pre-loading a die before the action that provokes it.

## Why

The dice seam works, but the interaction is a **pre-load**: because a mob's to-hit resolves *inside* the
player's provoking action (`run_mob_reactions` runs inline, then `next_player`, all in one
`SyncAuthority::submit`), the physical die must be dropped in the tray *before* you act. At a real
table you want the opposite: you move into the dark, the Wraith lunges, and *then* someone rolls its
d20 (or taps "Roll for me"). That is a roll **request** the engine issues mid-turn and waits on.

## The core tension

`SyncAuthority::submit` is **atomic**: authorize → apply (the whole turn, mob reactions included) → diff
→ commit one `Delta` → append one `LogEntry`. Replay determinism — the golden gates, saved campaigns,
the differential sync gate — rests on that atomicity: a game is a pure function of `(seed,
command-log)`, and every command either fully applies or is restored. A roll that blocks on external
input in the *middle* of `submit` would leave a half-applied command with no clean log entry.

So the design constraint is absolute: **never suspend a command mid-resolution.** The roll request must
fall on a command *boundary*.

### Rejected: suspend/resume continuation

The "obvious" async approach — freeze `submit` at the `draw_die` call, emit a request, resume when the
die arrives — is rejected. It requires serializing an engine continuation (hard in synchronous,
`no_std`-capable Rust), and worse, it puts a non-atomic, half-applied command into the log, breaking
replay and every golden gate. Not viable.

## Recommended: roll-gated explicit resolution

**Decouple mob reactions from the provoking action into explicit, roll-gated `Command::MobAttack`s, and
give the authority a small "awaiting reactions" state between the action and `next_player`.** This puts
every roll on a command boundary and *unifies solo play with the multiplayer model that already issues
mob attacks as explicit commands* (`Command::MobAttack { mob_id, target_id } => world.attack(...)`).

### The handshake

```
player action (Move-into-dark / Wait) ──submit──►  ┌─────────────────────────────┐
                                                    │ SyncAuthority               │
   ◄── Delta (action only) + PendingRolls ──────────┤  state: AwaitingReactions   │
                                                    │  queue: [Wraith→Ada, …]     │
   ── per pending roll ─────────────────────────►   │                             │
      RollRequest{ mob, target, sides:20 }          │                             │
   ◄── the table rolls (or "Roll for me") ──────────┤                             │
      SupplyDice{d20=14}  then  MobAttack{Wraith,Ada}│ resolves ONE reaction,      │
                                                     │ draws the supplied die/rng  │
   … repeat until the queue drains …                │                             │
   ── NextPlayer / (auto) ──────────────────────►   │ queue empty ⇒ next_player    │
                                                     └─────────────────────────────┘
```

1. **The action commits alone.** When a provoking action would trigger reactions, the authority applies
   the action, computes the *set* of reactions (`run_mob_reactions` split into a pure
   `pending_reactions()` that enumerates live, non-KO, co-located mobs **without** resolving them), and
   enters `AwaitingReactions { queue }` **instead of** running them + `next_player`. The committed
   `Delta` carries the action only.
2. **The authority exposes the queue.** A new read, `SyncAuthority::pending_rolls() -> &[PendingRoll]`
   (each `{ mob_id, target_id, sides }`), lets the driver know a roll is owed. On the board this becomes
   a `DeviceCommand::RollRequest { mob_id, target_id, sides, prompt }`.
3. **The table answers, one reaction at a time.** Either a physical `DiceRolled` → `SupplyDice` then a
   `MobAttack{mob,target}` (which consumes the supplied die via `draw_die`), or **"Roll for me"** → a
   bare `MobAttack` (no `SupplyDice`; `draw_die` falls to the seeded rng). Each `MobAttack` is a normal
   atomic command with its own `Delta` (damage + the existing `rolls d20 → n: …` cue) and log entry.
4. **The queue drains, then the turn advances.** When the last queued reaction resolves, the authority
   auto-issues `next_player` (or requires an explicit one) and leaves `AwaitingReactions`.

### Authority state

The only new engine state is the reaction queue + a latch, alongside the existing `solo_turn_started`:

```rust
enum TurnPhase { Idle, AwaitingReactions { queue: VecDeque<PendingRoll> } }
```

The queue freezes the *occupant order* at action time (matching the existing up-front `occupant_ids`
snapshot), but each reaction re-checks liveness + active-player KO as the cursor advances, and the
**remaining queue is dropped the moment the player is KO'd** — preserving today's "don't pile on a
downed player" `break` (see Resolved decisions §2).

`authorize` gates commands by phase: while `AwaitingReactions`, only the queued `MobAttack` (and its
optional preceding `SupplyDice`) is legal; player turn-actions are denied until reactions clear —
mirroring how the turn already can't advance mid-`run_mob_reactions`. Managed-turns multiplayer already
lives here (the GM issues each `MobAttack`); solo simply gains the same explicitness, driven by the
controller/surface instead of a human GM.

## Protocol additions

- **Outbound** `DeviceCommand::RollRequest { mob_id, target_id, sides, prompt }` — light the dice tray /
  prompt "The Wraith attacks Ada — roll its d20". The bridge emits one per `pending_rolls()` entry.
- **Inbound** is unchanged: `DeviceEvent::DiceRolled { sides, values }` (physical) resolves to
  `SupplyDice`; **"Roll for me"** is an inbound `MobAttack`-trigger with no die. (A thin
  `DeviceEvent::RollAuto { }`/`ResolveReaction` may be cleaner than surfacing `MobAttack` on the wire —
  see open questions.)

The existing `SupplyDice` + `draw_die` seam is **unchanged and reused**: the async flow just adds the
*prompt* and makes the mob attack an explicit step. The current pre-load model becomes the degenerate
case (supply early, resolve when the queue reaches it).

## Determinism & replay

The log stays a flat sequence of **atomic** commands — `[Move][SupplyDice][MobAttack][MobAttack]
[NextPlayer]…` — each fully applied or restored, exactly as today. `pending_rolls()` is *derived* state
(re-computed from room occupants), never serialized; on replay the recorded `MobAttack`s resolve the
same reactions in the same order, drawing the same recorded/seeded dice. So:

- **Golden gates:** the *facade* replay goldens change shape (mob reactions become explicit steps rather
  than inline cues on the provoking action) — a deliberate regeneration, reviewed like code. The
  *engine's numeric behavior* is identical (same `attack`, same `draw_die`).
- **Saved campaigns / sync gate:** unaffected in kind — more, smaller commits, same convergence.
- **`AwaitingReactions` across a snapshot boundary:** the phase/queue is transient (like `rng`,
  `supplied_dice`); a mid-reaction checkpoint must either drain first or the queue must be re-derivable
  from the world. Simplest: **checkpoint only in `Idle`** (never mid-reaction). Noted as a constraint.

## Solo vs. multiplayer

This *removes* the solo/multiplayer split in combat. Today solo auto-runs `run_mob_reactions` inline;
multiplayer issues explicit `MobAttack`s. Under this spec both drive the **same** explicit, roll-gated
`MobAttack` path — solo's "GM" is just the controller/surface draining `pending_rolls()`. The
`AuthorityOpts { solo }` flag's combat branch shrinks to "who drains the queue".

## "Roll for me" here

Cleaner than in the pre-load model: a `RollRequest` is answered by a bare `MobAttack` with no supplied
die, so `draw_die` draws the seeded rng — one click, one recorded command, deterministic. Optionally,
an "auto-resolve all pending" affordance drains the whole queue with rng in one gesture (still one
`MobAttack` command each, for replay).

## Migration / backward-compat

- Feature-flag the phase (`AuthorityOpts { async_reactions: bool }`, default `false`) so the current
  atomic solo loop stays the default until the surfaces adopt the handshake — no forced golden churn.
- The web surface's coroutine already loops on `submit` + server pushes; it grows a "resolve pending
  rolls" step after an action (render `RollRequest`s → tray → `MobAttack`). The controller loop and
  `--dry-run` grow the same drain step.

## Phasing

1. **Engine:** split `run_mob_reactions` into `pending_reactions()` (pure enumeration) + per-mob
   resolution; add `TurnPhase`/`pending_rolls()`; gate in `authorize`; defer `next_player`. Feature-
   flagged. Regenerate facade goldens.
2. **Bridge/protocol:** `RollRequest` out; `pending_rolls()` → requests; drain via `MobAttack`.
3. **Surfaces:** web dice tray reacts to `RollRequest` (prompt at the moment); controller `--dry-run`
   demonstrates a provoke → request → supply/auto → resolve cycle.
4. **Generalize:** the same queue mechanism extends to **player-attack to-hit** and any future scripted
   `Roll` node — every roll that wants a table prompt becomes a `RollRequest` on a command boundary.

## Resolved decisions

1. **No engine commands on the device protocol.** The wire stays physical *observations*: `RollRequest`
   out (a prompt — mob, target, sides), `DiceRolled` in (physical faces). The **controller** owns the
   translation — pending queue + `DiceRolled` → `SupplyDice` + `MobAttack`; a local "Roll for me" (or an
   optional timeout) → a bare `MobAttack` drawing the seeded rng — exactly as it already turns
   `PieceMoved` into `Move`. No `MobAttack`/`ResolveReaction` leaks onto the wire (the earlier
   `ResolveReaction` idea is dropped as redundant: the table names no `mob_id`/`target_id`; the engine
   already knows the pending reaction).

2. **One reaction at a time — a correctness requirement, not a preference.** `run_mob_reactions` today
   snapshots the occupant order up front, skips KO'd mobs, and **breaks the moment the active player is
   KO'd** ("don't pile on a downed player"). Batching all dice up front would resolve reactions after a
   KO and pile on. So the authority freezes the occupant *order*, advances a cursor one mob at a time,
   re-checks liveness + player-KO before each, and **drops the remaining queue on KO**; `pending_rolls()`
   yields only the next live reaction.

3. **Timeouts are a controller policy, never the engine.** The engine has no wall-clock (determinism)
   and simply waits in `AwaitingReactions`. Default: **no auto-timeout** — the player supplies a die or
   picks "Roll for me" (always available), so no one is rushed mid-turn. A controller may *optionally*
   auto-resolve unattended sessions after N seconds; the resulting `MobAttack` is recorded, so replay is
   unaffected and "N seconds" never enters the log.

4. **Player attacks roll too (decided — now built in the synchronous model).** Every attacker rolls the
   same d20 to-hit; players roll their own attacks, mobs default to the house roll. Combat-dependent
   golden fixtures supply hit dice (`SupplyDice`, on both command unions) so their outcomes stay
   deterministic — a supplied die draws no rng, so those goldens change only by the added roll cue. The
   async handshake below therefore prompts for **player attacks** (the attacker's own roll) as well as
   mob reactions; a player-issued `Attack` is itself a command boundary, so it fits with no extra
   machinery beyond mob reactions.

## Still open

- The exact `RollRequest` display payload — a prewritten `prompt` string from the engine vs. the surface
  composing its own from `mob_id`/`target_id` (leaning: ids + a short server-authored prompt).
- Whether the optional controller auto-timeout ships in phase 3 or waits for a real hardware session to
  show it's wanted.
