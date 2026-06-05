# Campaign Setup API + Integration Test — Design

Date: 2026-06-05

## Problem

`Character` stores its `#campaign` at construction with no setter, while
`Campaign`'s constructor required the full `party` and a `gm` (both
`PlayerCharacter`s, which each need the campaign). This is a circular
dependency: you cannot construct a campaign and its characters without a stub.
The existing unit tests sidestep it with `{} as ICampaign` stubs, but an
end-to-end integration test should wire real objects together.

The goal: reshape the `Campaign`/`PlayerCharacter` setup API so a campaign and
its party can be assembled cleanly with no stubs or casts, then add a layered
integration test that creates every object in a campaign, wires them up, and
drives player actions until `maxRounds` is reached.

## API Changes

### Campaign (`src/lib/campaign.ts`)

- **Constructor** becomes `new Campaign(title: string, maxRounds = 100)`.
  Drops the `party` and `gm` parameters. Initializes `party = []`, `#gm`
  unset, `#round = 0`. Activity tracking initializes against the (empty) party
  as before.
- **`set gm(pc)`** — new setter, the setup-time GM designation. Throws
  `ProceduralViolation` if the campaign has already begun. Performs a plain
  assignment otherwise; party-membership validation is deferred to
  `beginCampaign`. Pairs with the existing `get gm`.
- **`transfer(c)`** — unchanged. Keeps its `assertRunning` guard and remains
  the *only* way to change the GM once the campaign is running.
- **`beginCampaign()`** — adds validation before setting `#started`:
  - throws `ProceduralViolation` if `party.length === 0`
  - throws `ProceduralViolation` if `#gm` is unset or `!party.includes(#gm)`
- **`addPlayer(c)`** — renamed from `joinCampaign(c)` (disambiguates from the
  new `PlayerCharacter.joinCampaign()`). Behavior unchanged: keeps its
  `assertRunning` guard and remains the *mid-campaign* join path. Existing
  references in `campaign.test.ts` are updated to the new name.

### PlayerCharacter (`src/lib/character/player-character.ts`)

- **`joinCampaign()`** — new, the setup-time join path. Adds itself to
  `this.campaign.party` if not already present (dedup). No lifecycle guard
  (assembly happens before `beginCampaign`). Lives on `PlayerCharacter` (not
  `Character`) so `party: IPlayerCharacter[]` stays cast-free and NPCs cannot
  join a party.

### Two-paths summary

| Concern        | Setup-time (pre-begin)        | In-play (running)            |
| -------------- | ----------------------------- | ---------------------------- |
| Add a player   | `playerCharacter.joinCampaign()` | `campaign.addPlayer(pc)` (guarded) |
| Set the GM     | `campaign.gm = pc` (guarded vs begun) | `campaign.transfer(pc)` (guarded vs running) |

### Resulting wiring (no stubs, no casts)

```ts
const campaign = new Campaign("Wicked Ways", 5);
const hero = new PlayerCharacter(campaign, "Hero", makeStats());
const seer = new PlayerCharacter(campaign, "Seer", makeStats());
hero.joinCampaign();
seer.joinCampaign();
campaign.gm = hero;
campaign.beginCampaign();   // validates party non-empty + gm membership
```

## Turn / Action Coordination

Two independent "turn" notions must be reconciled by the test driver:

- **Character-level:** `actionsPerRound` (default 3); the budget-th recordable
  action auto-fires `character.endTurn()`.
- **Campaign-level:** `nextPlayer()` marks the active PC acted and advances;
  the wrap-around call fires `endRound()`, which increments `round` and calls
  `endCampaign()` at `maxRounds`.

`Campaign` never calls `startTurn`/`endTurn` on characters, so the driver does:

```ts
while (campaign.round < campaign.maxRounds) {
  const pc = campaign.activeCharacter;
  pc.startTurn();                 // reset action budget, fire onTurnStart
  scriptFor(pc, campaign.round);  // 1..actionsPerRound recordable actions
  campaign.nextPlayer();          // advance; last call of final round ends campaign
}
expect(campaign.round).toBe(campaign.maxRounds);
```

The loop guard is safe: the final `nextPlayer()` pushes `round` to `maxRounds`
and finishes the campaign, then the loop exits — `nextPlayer()` is never called
after `endCampaign()`.

## Test Changes

### 1. Rewrite `src/lib/campaign.test.ts`

The constructor signature change touches every existing case. The `makeCampaign`
helper builds the campaign, populates `party`, sets `gm`, and begins. Stub
players (`{ id } as IPlayerCharacter`) remain fine since `Campaign` compares by
identity. New coverage:

- `beginCampaign` throws when the party is empty.
- `beginCampaign` throws when `gm` is unset or not a member of the party.
- `gm` setter assigns before begin.
- `gm` setter throws once the campaign has begun.
- `transfer` remains the running-time GM hand-off (existing cases preserved).

The former "throws when there is no character at the active index" case is
reworked to access `activeCharacter` on an un-begun empty campaign (begin now
rejects an empty party).

### 2. Add `joinCampaign` tests to `src/lib/character/player-character.test.ts`

- adds the player to `campaign.party`
- dedups on a repeat call
- works before the campaign has begun

These use a minimal real party container (e.g. a campaign with a real `party`
array) rather than the `{} as ICampaign` stub, since the method touches `party`.

### 3. New `src/integration.test.ts`

Top-level so it visibly spans `lib/` + `utils/`. Picked up by `vitest run`.
Principle: **no mocks/stubs** — real `Campaign`, `PlayerCharacter`,
`NonPlayerCharacter`, `Room`, `Scene`, `Loot`, `Item`, `buildMap`. Deterministic:
a seeded RNG passed to `buildMap`, and fixed scripted actions.

- **smoke test:** wire every object type, drive the turn loop until
  `round === maxRounds`, assert clean completion (no throws, campaign finished,
  `round === maxRounds`).
- **scenario — combat:** a PC attacks a co-located NPC; the NPC's stats are
  chosen so the documented mitigation formula yields observable damage; assert
  the NPC's targeted stat drops by the computed amount.
- **scenario — looting:** a PC takes an item from a co-located `Loot` box;
  assert the item moves from box contents into inventory and `HELD_BY` updates.
- **scenario — scene:** a `Scene` registered on a room fires on entry; assert
  its observable effect (e.g. damage applied to occupants).

## Build Order (TDD)

Each API change is test-first (RED → GREEN), with the existing campaign tests
updated alongside the change that breaks them. The integration test comes last,
once the new setup API is in place.

1. Campaign constructor + `beginCampaign` validation + `gm` setter (update
   `campaign.test.ts`).
2. `PlayerCharacter.joinCampaign` (extend `player-character.test.ts`).
3. `src/integration.test.ts` (smoke + scenarios).

## Out of Scope (YAGNI)

- `PlayerCharacter.leaveCampaign()` — no requirement; `Campaign.leaveCampaign`
  stays the removal path.
- Loosening `party` to `ICharacter[]` / NPC party membership.
- Any change to the action/mitigation/status mechanics themselves.
