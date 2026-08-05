# Bounded modular map & the collapsing house (design)

> **Status:** design doc, not built. Extends **Option C** (modular-tile topology) in
> [`tabletop-position-sensing-adr.md`](./tabletop-position-sensing-adr.md). Specs a *bounded* physical
> board (e.g. 5×5) whose replayability and horror come from **tile churn** — rooms drawn from a larger
> deck and collapsed/replaced during play — rather than physical sprawl. Determinism reuses the
> dice-supply seam (a physical draw is recorded command data, exactly like `SuppliedDie`).

## The core move: unboundedness in *time*, not *space*

Cap the physical board at a fixed frame (5×5 = 25 slots). Draw the rooms from a **larger deck** (say
60+ tiles), so a single game surfaces only a subset — a different one each time. The board never grows;
the *house changes*. Three consequences:

1. **Replayability** — no two games lay out the same 25 rooms, before churn even enters.
2. **It settles the C1-vs-C2 hardware fork toward C2.** Unbounded maps were the only reason to prefer
   powered "smart pieces" (C1); a deliberately bounded board makes the cheap **passive-pieces-on-a-
   fixed-25-coil-baseboard (C2)** the right build. Bounded is the intended frame, not a limitation.
3. **"More rooms than slots" comes from churn** — discard-and-replace — not from a bigger table.

## Two churn models

Different feels; they lead to different rules and could ship as two modes off the *same* tiles and
baseboard.

- **Model α — the moving window (trailing collapse).** The 5×5 is a *viewport* that scrolls: as the
  party advances, rooms behind them collapse, their tiles return to the deck, and new rooms feed in
  ahead. Logical map = an endless delve; physical footprint ≤ 25. *Feel:* descent, relentless, "you
  can't go back — and if you try, it isn't the room you left." Backtracking is denied or punished.
- **Model β — the churning chamber (the "alternate dimension").** The 5×5 is a *fixed* house whose
  rooms **change identity in place** — the same corner of the table is the Study now and the Abyss
  later. *Feel:* noneuclidean, the house is alive, House-of-Leaves. The more distinctive of the two.

## What drives the swap — make it *sinister*, not *random*

The load-bearing rule: **churn must read as intent** — the house is doing this *to you*, not rolling
dice. The primary trigger ties straight into the lantern/darkness mechanic already built:

> **The unlit is reclaimed.** A room you leave and let fall dark is consumed — its tile returns to the
> deck. Return, and a *different* room has grown in its place. **Light is the only thing that keeps a
> room real** — so the lantern becomes a *spatial* resource, not just visibility.

Secondary triggers to layer: **sanity-warp** (low Sanity distorts geometry), **threshold portals**
(one-way dimensional doors that swap a whole wing), **timed decay** (a room crumbles after N turns
unvisited). All legible, all "the house's fault."

## Engine & determinism

The map shifts from a static genesis snapshot to a **procedural, mutable** structure — rooms enter and
leave the graph mid-game. This lands on machinery that already exists:

- **A physical tile drawn from a shuffled deck is randomness entering from outside the engine** —
  identical in kind to a physical die. So a draw is *supplied* as recorded command data:
  `SupplyTile { slot, uid }`, the structural twin of `SuppliedDie` / `SupplyDice`. Replay reproduces
  the same draws because they are in the log.
- **Churn = recorded map mutations** (`CollapseRoom`, `PlaceRoom`) drawn through `World.rng` (seeded) or
  supplied as commands. `game = f(seed, command-log)` still holds, and the golden gates still pin it.
- **Self-tracking swaps.** Because the modular tiles are NFC-tagged and the baseboard reads which UID
  sits in each slot (see ADR Option C), discard-and-replace is legible to the engine automatically:
  place a new tile → the board reads the new UID → the engine updates that slot's room. The `PieceOn`
  seam gains a sibling `TileIn { slot, uid }` (or the controller derives it).
- **The real new work** is making `World`'s map mutable rather than fixed at genesis, and giving the
  live map/deck/collapsed-pile a **serialization shape** (they become snapshot + save state). That is a
  meatier change than dice, with golden/save implications — expect deliberate golden regeneration.

## Replayability compounds (multiplicatively)

`which subset of the deck surfaces` × `how tiles are placed/connected` × `which rooms churn in over the
game` × `seed-driven encounters`. A modest deck yields enormous variance. It also supercharges the
razor-and-blades model from Option C: **every expansion tile-pack deepens the deck for every existing
campaign**, raising variety on boards people already own.

## Design guardrails (the traps, and how to dodge them)

- **Preserve some spatial mastery.** Constant reshuffling erases the satisfaction of learning the house
  and reads as arbitrary. *Dodge:* keep churn **rule-bound and punctuated** (acts/thresholds, or *only*
  the unlit rooms) so players still map the lit core; only the neglected edges betray them.
- **Anchor rooms.** If a room holding an objective collapses, the quest breaks. *Dodge:* flag
  objective/story tiles **un-collapsible**, or **migrate** the objective with a cue ("the altar is
  somewhere new"). Lives naturally in `VictoryConditionBehavior`.
- **Pacing / table fuss.** Physical tile-swapping is handling overhead. *Dodge:* favor α's automatic
  trailing collapse, or batch β's swaps into discrete "the house shifts" beats — never per-move.
- **Fairness.** Procedural layouts can deal unsolvable hands. *Dodge:* **guided generation** — the
  deck/rules guarantee an objective path. Authored-generation work, but bounded.

## Open questions

- **Deck-to-board ratio** for a target session length and replay curve (how many tiles per campaign).
- **Collapsed rooms:** reshuffle into the deck (can recur) vs. a separate discard (gone for the game)?
- **Backtracking semantics:** is a returned-to room *guaranteed* different, or only if it went dark?
- **Multiplayer sync:** churn as authoritative `Delta`s; how managed-turns and the sync gate treat
  mutable-map mutations.
