# Campaign Setup API + Integration Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the `Campaign`/`PlayerCharacter` setup API to remove the construction-time circular dependency, then add a layered integration test that wires every campaign object together and runs to `maxRounds`.

**Architecture:** `Campaign` is constructed empty (`title`, `maxRounds`); players add themselves with `PlayerCharacter.joinCampaign()`; the GM is designated with the setup-only `campaign.gm =` setter; `beginCampaign()` validates the party and GM membership. The in-play join path is renamed `Campaign.addPlayer()`, and `transfer()` remains the in-play GM hand-off. A new `src/integration.test.ts` exercises the real objects end-to-end.

**Tech Stack:** TypeScript, Vitest. Tests run with `npm test` (`vitest run`). Full gate: `npm run checks` (lint + typecheck + test).

---

## File Structure

- **Modify** `src/lib/campaign.ts` — new constructor, `gm` setter with begun-guard, `beginCampaign` validation, rename `joinCampaign` → `addPlayer`, interface updates.
- **Modify** `src/lib/campaign.test.ts` — rewrite the `makeCampaign` helper and existing cases to the new API; add validation + setter tests.
- **Modify** `src/lib/character/player-character.ts` — add `joinCampaign()` and declare it on `IPlayerCharacter`.
- **Modify** `src/lib/character/player-character.test.ts` — add `joinCampaign` tests.
- **Create** `src/integration.test.ts` — layered smoke + scenario tests.

Reference facts pulled from the current source (do not guess these):

- **Damage:** `Character.takeDamage(strength, stat)` applies `strength * ((10 - mitigator) * 0.2)` to `stats[stat]`, where `mitigator = stats[MitigatorStatType[stat]]`. `MitigatorStatType.health === "sanity"` (health is mitigated by sanity). So an unarmed attack (`strength 1`, `stat health`) against a target with `sanity: 5` deals `1 * ((10-5)*0.2) = 1` health damage. A target with `sanity: 5` stays "normal" (fear triggers only at `sanity < 5`, panic at `<= 0`).
- **Turn coupling:** `Campaign` never calls `startTurn`/`endTurn`; the driver must call `pc.startTurn()` before a PC acts. `actionsPerRound` defaults to `3`; the 3rd recordable action auto-fires `endTurn()`.
- **`nextPlayer()`** marks the active PC acted and advances; the wrap-around call fires `endRound()` → increments `round` → calls `endCampaign()` at `maxRounds`. After `endCampaign()`, any further `nextPlayer()` throws `ProceduralViolation`.
- **`PlayerCharacter.attack(c)`** does not require co-location; an unarmed attack (no equipped weapon) deals 1 health damage.
- **`Room` constructor:** `new Room(description, loot: ILoot[], exits: Record<Direction, IRoom>)`; passing `{}` for exits is valid. `enterRoom` adds the occupant *then* plays "enter" scenes, so the entering character is already in `room.occupants` when a scene script runs.
- **`Loot` constructor:** `new Loot(description, contents: IItem[])`; capacity is `contents.length + 2`.
- **`Item` constructor:** `new Item({type, recipe, modifier, stat}, properties, actions, events)` — see Task 5 for a complete factory.
- **`HELD_BY`** is an exported symbol from `src/lib/inventory.ts`; read an item's holder via `item[HELD_BY]`.
- **`buildMap(rooms, { rng, extraConnections })`** mutates and returns `rooms`, building a connected spanning tree; inject `rng` for determinism. Every room ends with ≥1 exit.

---

## Task 1: Campaign setup API

**Files:**
- Modify: `src/lib/campaign.ts`
- Modify: `src/lib/campaign.test.ts`

This task changes the `Campaign` constructor signature, which breaks every case in `campaign.test.ts` at once, so the test file and implementation are updated together. We write/adjust the tests first (RED), then implement (GREEN).

- [ ] **Step 1: Rewrite the test helper and existing cases to the new API**

In `src/lib/campaign.test.ts`, replace the `makeCampaign` helper (lines ~14-26) with:

```ts
function makeCampaign(
  partySize: number,
  maxRounds?: number,
  begin = true,
): { campaign: Campaign; party: IPlayerCharacter[]; gm: IPlayerCharacter } {
  const campaign = new Campaign("The Haunting", maxRounds);
  const party = Array.from({ length: partySize }, makePlayer);
  for (const player of party) {
    campaign.party.push(player);
  }
  const gm = party[0] ?? makePlayer();
  if (party.length > 0) {
    campaign.gm = gm;
  }
  if (begin) {
    campaign.beginCampaign();
  }
  return { campaign, party, gm };
}
```

Then make these edits to existing cases:
- In the `activeCharacter` "throws when there is no character at the active index" case (~line 57), change `makeCampaign(0)` to `makeCampaign(0, undefined, false)` (an empty party can no longer be begun; the `activeCharacter` getter still throws without begin).
- In `describe("joinCampaign", ...)` (~line 131): rename the `describe` to `"addPlayer"` and change `campaign.joinCampaign(newcomer)` to `campaign.addPlayer(newcomer)`.
- In the two lifecycle cases that reference `campaign.joinCampaign(makePlayer())` (~lines 252 and 264), change them to `campaign.addPlayer(makePlayer())`.

- [ ] **Step 2: Add the new validation and setter tests**

In `src/lib/campaign.test.ts`, add this block inside the top-level `describe("Campaign", ...)`:

```ts
describe("beginCampaign validation", () => {
  it("throws when the party is empty", () => {
    const campaign = new Campaign("Empty");

    expect(() => campaign.beginCampaign()).toThrow(ProceduralViolation);
  });

  it("throws when the gm is not a member of the party", () => {
    const campaign = new Campaign("Mismatch");
    campaign.party.push(makePlayer());
    campaign.gm = makePlayer(); // a gm who never joined the party

    expect(() => campaign.beginCampaign()).toThrow(ProceduralViolation);
  });

  it("begins when the party is non-empty and contains the gm", () => {
    const campaign = new Campaign("Valid");
    const gm = makePlayer();
    campaign.party.push(gm);
    campaign.gm = gm;

    expect(() => campaign.beginCampaign()).not.toThrow();
  });
});

describe("gm setter", () => {
  it("assigns the gm before the campaign begins", () => {
    const campaign = new Campaign("Setup");
    const gm = makePlayer();
    campaign.party.push(gm);

    campaign.gm = gm;

    expect(campaign.gm).toBe(gm);
  });

  it("throws when assigning the gm after the campaign has begun", () => {
    const { campaign, party } = makeCampaign(2);
    const other = party[1]!;

    expect(() => {
      campaign.gm = other;
    }).toThrow(ProceduralViolation);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/lib/campaign.test.ts`
Expected: FAIL — the new constructor arity / `addPlayer` / `gm` setter / validation do not exist yet (type errors and assertion failures).

- [ ] **Step 4: Implement the Campaign changes**

In `src/lib/campaign.ts`, update the interface members:

```ts
  get activeCharacter(): IPlayerCharacter;
  get gm(): IPlayerCharacter | undefined;
  set gm(pc: IPlayerCharacter | undefined);
  get round(): number;
```

and rename the `joinCampaign` interface method to:

```ts
  addPlayer: (c: IPlayerCharacter) => void;
```

In the class, change the `#gm` field and getter to allow `undefined`, add the guarded setter, replace the constructor, add `beginCampaign` validation, and rename `joinCampaign`:

```ts
  #gm: IPlayerCharacter | undefined;
```

```ts
  get gm() {
    return this.#gm;
  }

  set gm(pc: IPlayerCharacter | undefined) {
    if (this.#started) {
      throw new ProceduralViolation(
        "Cannot set the GM after the campaign has begun; use transfer() instead",
      );
    }
    this.#gm = pc;
  }
```

```ts
  constructor(title: string, maxRounds: number = 100) {
    this.id = generateId<CampaignId>();
    this.title = title;
    this.party = [];
    this.#round = 0;
    this.#gm = undefined;
    this.maxRounds = maxRounds;

    this.#actedThisRound = new WeakMap<IPlayerCharacter, boolean>();
    this.#resetActivity();

    this.#activeCharacterIndex = 0;
  }
```

```ts
  beginCampaign() {
    if (this.#started) {
      throw new ProceduralViolation("Campaign has already begun");
    }
    if (this.party.length === 0) {
      throw new ProceduralViolation("Cannot begin a campaign with no party");
    }
    if (!this.#gm || !this.party.includes(this.#gm)) {
      throw new ProceduralViolation(
        "Cannot begin a campaign whose GM is not a member of the party",
      );
    }
    this.#started = true;
  }
```

Rename the `joinCampaign` method to `addPlayer` (body unchanged):

```ts
  addPlayer(c: IPlayerCharacter) {
    this.#assertRunning();
    this.party.push(c);
  }
```

Leave `transfer` unchanged — it writes `this.#gm = c` directly (past `assertRunning`), bypassing the public setter's begun-guard, which is exactly what we want for the in-play hand-off.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/lib/campaign.test.ts`
Expected: PASS — all Campaign cases green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "Reshape Campaign setup API: empty constructor, gm setter, addPlayer"
```

---

## Task 2: PlayerCharacter.joinCampaign

**Files:**
- Modify: `src/lib/character/player-character.ts`
- Modify: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/player-character.test.ts`, add the campaign import near the top with the other imports:

```ts
import { Campaign } from "../campaign";
```

Then add this block inside the top-level `describe("PlayerCharacter", ...)`:

```ts
describe("joinCampaign", () => {
  it("adds itself to the campaign party", () => {
    const campaign = new Campaign("Quest");
    const pc = new PlayerCharacter(campaign, "Hero", makeStats());

    pc.joinCampaign();

    expect(campaign.party).toContain(pc);
  });

  it("does not add itself twice", () => {
    const campaign = new Campaign("Quest");
    const pc = new PlayerCharacter(campaign, "Hero", makeStats());

    pc.joinCampaign();
    pc.joinCampaign();

    expect(campaign.party.filter((member) => member === pc)).toHaveLength(1);
  });

  it("can join before the campaign has begun", () => {
    const campaign = new Campaign("Quest");
    const pc = new PlayerCharacter(campaign, "Hero", makeStats());

    expect(() => pc.joinCampaign()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/character/player-character.test.ts`
Expected: FAIL — `pc.joinCampaign is not a function` (and a type error).

- [ ] **Step 3: Implement joinCampaign**

In `src/lib/character/player-character.ts`, add the method to the `IPlayerCharacter` interface:

```ts
export interface IPlayerCharacter extends ICharacter {
  joinCampaign: () => void;
  attack: <C extends ICharacter>(c: C) => void;
  openLootBox: (lootBox: ILoot) => readonly IItem[];
  takeFromLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  putInLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
}
```

and implement it on the class (place it just after the constructor):

```ts
  joinCampaign() {
    const { party } = this.campaign;
    if (!party.includes(this)) {
      party.push(this);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/character/player-character.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/player-character.ts src/lib/character/player-character.test.ts
git commit -m "Add PlayerCharacter.joinCampaign setup-time self-join"
```

---

## Task 3: Integration test — smoke (wires + runs to maxRounds)

**Files:**
- Create: `src/integration.test.ts`

- [ ] **Step 1: Write the smoke test with its shared helpers**

Create `src/integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { Campaign } from "./lib/campaign";
import { HELD_BY, Item } from "./lib/inventory";
import { Loot } from "./lib/loot";
import { Room } from "./lib/room";
import { Scene } from "./lib/scene";
import { ProceduralViolation } from "./lib/util";
import { Character } from "./lib/character/character";
import { NonPlayerCharacter } from "./lib/character/non-player-character";
import { PlayerCharacter } from "./lib/character/player-character";
import { StatType, type Stats } from "./lib/character/stats";
import { buildMap } from "./utils/build-map";

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
    ...overrides,
  };
}

// Deterministic mulberry32 PRNG so buildMap produces a fixed topology.
function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A real weapon Item with inert actions/events, usable in inventories and boxes.
function makeWeapon(modifier = 3): Item {
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 1 },
      modifier,
      stat: StatType.Health,
    },
    { equippable: true, equipped: false, destroyable: false, usable: false },
    {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
    { onPickUp: () => {} },
  );
}

describe("Campaign integration", () => {
  it("wires every object type and runs turns until maxRounds", () => {
    const maxRounds = 3;
    const campaign = new Campaign("Wicked Ways", maxRounds);

    // Two player characters bound to the real campaign — no stubs, no casts.
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    const seer = new PlayerCharacter(campaign, "Seer", makeStats());
    hero.joinCampaign();
    seer.joinCampaign();
    campaign.gm = hero;

    // Rooms connected into a deterministic spanning tree.
    const rooms = [
      new Room("Entrance", [], {}),
      new Room("Corridor", [], {}),
      new Room("Vault", [], {}),
    ];
    buildMap(rooms, { rng: makeRng(42), extraConnections: 1 });

    // Loot wired into a room.
    const chest = new Loot("oak chest", [makeWeapon()]);
    rooms[2]!.loot.set(chest.id, chest);

    // An NPC placed in a room.
    const npc = new NonPlayerCharacter(
      campaign,
      "Caretaker",
      makeStats(),
      "Welcome, travellers.",
      [{ type: "exact", trigger: "help", response: ["Mind the vault."] }],
    );
    npc.move(rooms[0]!);

    // A harmless scene that counts occupants when entered. Registered on the
    // starting room so the deterministically-seeded PCs are guaranteed to
    // trigger it, independent of the buildMap topology.
    let sceneEntries = 0;
    const watcher = new Scene({
      phase: "enter",
      preconditions: [],
      script: (room) => {
        sceneEntries += room.occupants.length;
      },
    });
    rooms[0]!.registerScene(watcher);

    campaign.beginCampaign();

    // Seed each PC into the first room before the loop.
    hero.move(rooms[0]!);
    seer.move(rooms[0]!);

    // Drive the turn loop. Each PC walks to a deterministic adjacent room.
    while (campaign.round < campaign.maxRounds) {
      const pc = campaign.activeCharacter;
      const exits = [...pc.currentRoom!.exits.values()];
      const next = exits[0] ?? pc.currentRoom!;
      pc.startTurn();
      pc.move(next);
      campaign.nextPlayer();
    }

    // The campaign reached maxRounds and auto-finished.
    expect(campaign.round).toBe(maxRounds);
    expect(() => campaign.nextPlayer()).toThrow(ProceduralViolation);

    // Everything stayed wired together.
    expect(campaign.party).toEqual([hero, seer]);
    expect(campaign.gm).toBe(hero);
    expect(npc.dialogue()).toEqual(["Welcome, travellers."]);
    expect(rooms[2]!.loot.get(chest.id)).toBe(chest);
    expect(sceneEntries).toBeGreaterThan(0);
    expect(npc).toBeInstanceOf(Character);
  });
});
```

- [ ] **Step 2: Run the smoke test to verify it passes**

Run: `npm test -- src/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "Add campaign integration smoke test"
```

---

## Task 4: Integration test — combat scenario

**Files:**
- Modify: `src/integration.test.ts`

- [ ] **Step 1: Write the combat scenario**

Append this `it` inside the `describe("Campaign integration", ...)` block in `src/integration.test.ts`:

```ts
  it("resolves combat between a player character and a co-located npc", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    // sanity 5 mitigates a 1-point unarmed health attack to exactly 1 damage,
    // and keeps the npc "normal" (fear is only below sanity 5).
    const ghoul = new NonPlayerCharacter(
      campaign,
      "Ghoul",
      makeStats({ [StatType.Sanity]: 5 }),
      "Hgrrr",
      [],
    );

    const crypt = new Room("Crypt", [], {});
    campaign.beginCampaign();
    hero.move(crypt);
    ghoul.move(crypt);

    expect(crypt.occupants).toContain(hero);
    expect(crypt.occupants).toContain(ghoul);

    hero.startTurn();
    hero.attack(ghoul);

    expect(ghoul.stats[StatType.Health]).toBe(9);
    expect(ghoul.isNormal).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npm test -- src/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "Add combat scenario to campaign integration test"
```

---

## Task 5: Integration test — looting scenario

**Files:**
- Modify: `src/integration.test.ts`

- [ ] **Step 1: Write the looting scenario**

Append this `it` inside the `describe("Campaign integration", ...)` block in `src/integration.test.ts`:

```ts
  it("lets a player character take loot from a co-located box", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    const sword = makeWeapon();
    const chest = new Loot("treasure chest", [sword]);
    const vault = new Room("Vault", [chest], {});

    campaign.beginCampaign();
    hero.move(vault);
    hero.startTurn();

    const taken = hero.takeFromLootBox(chest, sword);

    expect(taken).toEqual([sword]);
    expect(hero.inventory.items).toContain(sword);
    expect(chest.contents).not.toContain(sword);
    expect(sword[HELD_BY]).toBe(hero);
  });
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npm test -- src/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "Add looting scenario to campaign integration test"
```

---

## Task 6: Integration test — scene trigger scenario

**Files:**
- Modify: `src/integration.test.ts`

- [ ] **Step 1: Write the scene scenario**

Append this `it` inside the `describe("Campaign integration", ...)` block in `src/integration.test.ts`:

```ts
  it("fires a registered scene when a player character enters the room", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    let firedWithOccupants = 0;
    const trap = new Scene({
      phase: "enter",
      preconditions: [],
      script: (room) => {
        firedWithOccupants = room.occupants.length;
      },
    });
    const hall = new Room("Trapped Hall", [], {});
    hall.registerScene(trap);

    campaign.beginCampaign();
    hero.move(hall);

    // enterRoom adds the occupant before playing scenes, so the entering hero
    // is visible to the script.
    expect(firedWithOccupants).toBe(1);
    expect(hall.occupants).toContain(hero);
  });
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npm test -- src/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "Add scene-trigger scenario to campaign integration test"
```

---

## Task 7: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the complete checks**

Run: `npm run checks`
Expected: lint passes, `tsc --noEmit` reports no errors, and all test files pass (campaign, player-character, and integration included).

- [ ] **Step 2: If anything fails, fix it and re-run**

Address any lint/type/test failure surfaced above, then re-run `npm run checks` until clean. Commit any fixes:

```bash
git add -A
git commit -m "Fix lint/type/test issues from integration work"
```
```

