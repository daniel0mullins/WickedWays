# Mob Encounters & Loot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mobs a real combat lifecycle — a Health-gated escape roll, automatic loot/material/key drops on defeat, room-attached vs. campaign-roving origin, and a dedicated `EncounterTable` that spawns weighted formations on first room entry.

**Architecture:** A new focused `EncounterTable` unit owns formations, weighted selection, the spawn-chance roll, and visited-room tracking; `Campaign` composes one and exposes thin `addFormation`/`maybeSpawn` methods. Mobs distribute drops via a KO-transition hook (`onKnockOut`) added to `Character`. Unforgeable state transitions use the existing symbol-seam pattern; three new symbols (`SET_ORIGIN`, `PLACE`, `STASH_DROP`) are added. All randomness routes through the existing `roll(sides, rng)` dice primitive and an injected `rng`.

**Tech Stack:** TypeScript, Vitest (`npm test` = `vitest run`; single file: `npx vitest run <path>`), ESLint (`npm run lint`), tsc (`npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-06-11-mob-encounters-and-loot-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/lib/util.ts` | shared helpers | **add** `clamp` |
| `src/lib/dice.ts` | dice primitive | (unchanged — reused) |
| `src/lib/character/history.ts` | action history union | `escape` entry gains `success` |
| `src/lib/character/character.ts` | base character | protected `rng`; KO-transition hook `onKnockOut`; `[PLACE]` seam |
| `src/lib/inventory.ts` | item types + symbols | **add** `SET_ORIGIN`, `PLACE`, `STASH_DROP` symbols |
| `src/lib/loot.ts` | loot container | **add** `[STASH_DROP]` (key/capacity-bypassing stow) |
| `src/lib/character/mob.ts` | mob | escape roll; origin + `[SET_ORIGIN]`; load drops; `materialDrops`; `onKnockOut` drop logic |
| `src/lib/room.ts` | room | `spawnModifier`; `placeMob`; resident `mobs` ctor param |
| `src/lib/encounter-table.ts` | **new** — formations + spawning | `Formation`, `EncounterTable` |
| `src/lib/campaign.ts` | campaign | `options` (rng, baseEncounterChance); compose `EncounterTable`; `addFormation`, `maybeSpawn` |
| `src/lib/character/player-character.ts` | player | `move` triggers `maybeSpawn` |
| `src/test-utils.ts` | shared test stubs | `makeCampaign` gains `maybeSpawn` no-op |
| `README.md` | docs | Mob encounters & loot section |

Tests live beside their unit as `*.test.ts` (e.g. `src/lib/encounter-table.test.ts`).

---

## Task 1: Randomized Health-gated escape

**Files:**
- Create: (none)
- Modify: `src/lib/util.ts`, `src/lib/character/character.ts`, `src/lib/character/history.ts`, `src/lib/character/mob.ts`
- Test: `src/lib/character/mob.test.ts`, `src/lib/character/history.test.ts` (if present — see Step 3)

- [ ] **Step 1: Add the `clamp` helper to `util.ts`**

Append to `src/lib/util.ts`:

```ts
/**
 * Clamps `n` into the inclusive range `[lo, hi]`.
 *
 * @param n - Value to clamp.
 * @param lo - Lower bound.
 * @param hi - Upper bound.
 * @returns `n` constrained to `[lo, hi]`.
 */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
```

- [ ] **Step 2: Expose a protected `rng` on `Character`**

In `src/lib/character/character.ts`, add a protected field and set it in the constructor *before* the `Afflictions` are built, then feed it to the afflictions so a single rng drives everything.

Add the field near the other private fields (e.g. just below `#currentRoom`):

```ts
  /** Injected randomness for all of this character's rolls (escape, etc.). */
  protected readonly rng: () => number;
```

In the constructor, replace:

```ts
    this.#afflictions = new Afflictions(
      options.rng,
      options.afflictionConfig ?? DEFAULT_AFFLICTION_CONFIG,
    );
```

with:

```ts
    this.rng = options.rng ?? Math.random;
    this.#afflictions = new Afflictions(
      this.rng,
      options.afflictionConfig ?? DEFAULT_AFFLICTION_CONFIG,
    );
```

- [ ] **Step 3: Update the `escape` history entry to carry `success`**

In `src/lib/character/history.ts`, change the `escape` union member:

```ts
  | { kind: "escape"; round: number; success: boolean }
```

and update `describeAction`'s escape case:

```ts
    case "escape":
      return entry.success ? "escaped" : "failed to escape";
```

If `src/lib/character/history.test.ts` exists and asserts the escape description, update/extend it:

```ts
  it("describes a successful escape", () => {
    expect(describeAction({ kind: "escape", round: 0, success: true })).toBe("escaped");
  });

  it("describes a failed escape", () => {
    expect(describeAction({ kind: "escape", round: 0, success: false })).toBe(
      "failed to escape",
    );
  });
```

Run: `npx vitest run src/lib/character/history.test.ts` (skip if the file does not exist).
Expected: PASS.

- [ ] **Step 4: Write the failing escape tests**

In `src/lib/character/mob.test.ts`, replace the existing `describe("escape", ...)` block. First update the existing movement tests to inject a success-guaranteeing rng, then add failure coverage. The full replacement block:

```ts
  describe("escape", () => {
    // baseEscapeChance(50) + effective Health(10 from makeStats) = 60; rng()=>0
    // rolls a 1 (<= 60) so escape always succeeds, and rng()=>0 selects exit 0.
    it("flees through an exit on a successful roll", () => {
      const mob = makeMob({ rng: () => 0 });
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.currentRoom).toBe(cave);
      expect(cave.occupants).toContain(mob);
      expect(den.occupants).not.toContain(mob);
    });

    it("records escape as an action", () => {
      const mob = makeMob({ actionsPerRound: 1, rng: () => 0 });
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);
      mob.startTurn(); // reset the (no-op) action count from move()
      const onTurnEnd = vi.spyOn(mob.events, "onTurnEnd");

      mob.escape();

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("does not throw and still records when the mob is in no room", () => {
      const mob = makeMob({ actionsPerRound: 1, rng: () => 0 });
      const onTurnEnd = vi.spyOn(mob.events, "onTurnEnd");

      expect(() => mob.escape()).not.toThrow();
      expect(mob.currentRoom).toBeNull();
      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("records a successful escape in history", () => {
      const mob = makeMob({ rng: () => 0 });
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(
        mob.history.some((e) => e.kind === "escape" && e.success),
      ).toBe(true);
    });

    it("does not move when the current room has no exits", () => {
      const mob = makeMob({ rng: () => 0 });
      const sealed = new Room("Sealed", "Sealed", [], {} as ExitsArg);
      mob.move(sealed);

      mob.escape();

      expect(mob.currentRoom).toBe(sealed);
      expect(
        mob.history.some((e) => e.kind === "escape" && !e.success),
      ).toBe(true);
    });

    it("stays put and records a failed escape on a failed roll", () => {
      // threshold = 50 + Health(5) = 55; rng()=>0.99 rolls 100 (> 55) => fail.
      const mob = makeMob({ stats: { [StatType.Health]: 5 }, rng: () => 0.99 });
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.currentRoom).toBe(den);
      expect(mob.history.at(-1)).toMatchObject({ kind: "escape", success: false });
    });
  });
```

Run: `npx vitest run src/lib/character/mob.test.ts`
Expected: FAIL — `escape` still always moves through the first exit and records `{ kind: "escape" }` without `success`; the failed-roll and no-exit `success` assertions fail, and the file may not yet compile against the new history shape.

- [ ] **Step 5: Rewrite `Mob.escape`**

In `src/lib/character/mob.ts`, update the imports and the `escape` method. Add to the imports:

```ts
import { roll } from "../dice";
import { clamp } from "../util";
import { StatType } from "./stats";
```

Add a private field and a constructor option for the base chance. Change the `options` parameter type to:

```ts
    options: {
      rng?: () => number;
      afflictionConfig?: AfflictionConfig;
      baseEscapeChance?: number;
    } = {},
```

Add the field and initialise it in the constructor (after `super(...)`):

```ts
  /** Base escape chance before the Health bonus; 0–100. */
  #baseEscapeChance: number;
```

```ts
    this.#baseEscapeChance = options.baseEscapeChance ?? 50;
    this.isActionMap.set(this.escape, true);
```

Replace the `escape` method body:

```ts
  /**
   * Attempts to flee the current room. Success is a Health-gated roll:
   * `roll(100) <= clamp(baseEscapeChance + effective Health, 0, 100)` *and* an
   * exit must exist. On success the mob moves through a randomly chosen exit
   * (gate-suppressed, so it does not consume a second action). Whether it
   * succeeds or fails, the `escape` action is recorded and the budget ticks.
   */
  escape() {
    if (!this.attemptAction(this.escape, false)) return;
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const threshold = clamp(
      this.#baseEscapeChance + this.effectiveStat(StatType.Health),
      0,
      100,
    );
    const success = roll(100, this.rng) <= threshold && exits.length > 0;
    if (success) {
      const destination = exits[roll(exits.length, this.rng) - 1]!;
      this.withGateSuppressed(() => this.move(destination));
    }
    this.recordAction(this.escape, { kind: "escape", success });
  }
```

Also update the `IMob.escape` doc comment to reflect the roll:

```ts
  /** Attempts a Health-gated flee through a random exit, recording an `escape`. */
  escape: () => void;
```

- [ ] **Step 6: Run the escape tests**

Run: `npx vitest run src/lib/character/mob.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/lib/util.ts src/lib/character/character.ts src/lib/character/history.ts src/lib/character/mob.ts src/lib/character/mob.test.ts src/lib/character/history.test.ts
git commit -m "feat: Health-gated mob escape roll with random exit"
```

---

## Task 2: KO-transition hook (`onKnockOut`)

A `protected onKnockOut()` fires once when `Status.KO` newly latches during a reconcile. Default is a no-op; `Mob` overrides it in Task 4.

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/character/character.test.ts`, add a test that subclasses `Character` to observe the hook. Place it in a new `describe` block. (The `Character` constructor and `StatType` are already imported in this file; `makeCampaign`/`makeStats` too.)

```ts
  describe("onKnockOut hook", () => {
    class HookSpy extends Character {
      knockOuts = 0;
      protected onKnockOut() {
        this.knockOuts += 1;
      }
    }

    function makeSpy(health: number) {
      return new HookSpy(makeCampaign(), "Spy", makeStats({ [StatType.Health]: health }));
    }

    it("fires once when KO newly latches", () => {
      const spy = makeSpy(0);
      spy.takeDamage(0); // reconcile -> health <= 0 -> KO transition
      expect(spy.knockOuts).toBe(1);
    });

    it("does not fire again on subsequent reconciles while still KO'd", () => {
      const spy = makeSpy(0);
      spy.takeDamage(0);
      spy.takeDamage(0);
      spy.endTurn();
      expect(spy.knockOuts).toBe(1);
    });

    it("does not fire for a character that never becomes KO'd", () => {
      const spy = makeSpy(10);
      spy.takeDamage(0);
      expect(spy.knockOuts).toBe(0);
    });
  });
```

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — `onKnockOut` does not exist / is never called, so `knockOuts` stays `0`.

- [ ] **Step 2: Implement the hook**

In `src/lib/character/character.ts`, replace `#reconcile`:

```ts
  #reconcile() {
    const wasKO = this.#afflictions.list.includes(Status.KO);
    this.#afflictions.applyFromStats(
      this.#floorAndSnapshot(),
      this.#passiveImmunities(),
    );
    const isKO = this.#afflictions.list.includes(Status.KO);
    if (!wasKO && isKO) {
      this.onKnockOut();
    }
  }

  /**
   * Hook fired exactly once when this character's {@link Status.KO} newly
   * latches during a reconcile. Base behaviour is none; subclasses (e.g.
   * {@link Mob}) override it to react to defeat.
   */
  protected onKnockOut(): void {}
```

- [ ] **Step 3: Run the test, typecheck, lint, commit**

Run: `npx vitest run src/lib/character/character.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "feat: Character.onKnockOut hook fires once on KO transition"
```

---

## Task 3: New symbols + `Loot[STASH_DROP]` + `Character[PLACE]`

Adds the three engine-internal seams the later tasks need: `STASH_DROP` (force an item — including a key — into a loot box), `PLACE` (wire a character into a room with no history/gating), and `SET_ORIGIN` (defined here, used in Task 4).

**Files:**
- Modify: `src/lib/inventory.ts`, `src/lib/loot.ts`, `src/lib/character/character.ts`
- Test: `src/lib/loot.test.ts`, `src/lib/character/character.test.ts`

- [ ] **Step 1: Add the three symbols**

In `src/lib/inventory.ts`, after the existing `CONSUME_VIA_USE` symbol, add:

```ts
/**
 * Symbol-keyed method that forces an item (including a key) into a {@link Loot}
 * box, bypassing the player-facing "no keys in loot" and capacity guards. Only
 * the mob defeat-drop path calls it.
 */
export const STASH_DROP = Symbol("stashDrop");

/**
 * Symbol-keyed method that wires a character into a room (sets current room and
 * occupancy) with no gating, history, or budget tick. Engine-internal: room
 * placement and encounter spawning call it.
 */
export const PLACE = Symbol("place");

/**
 * Symbol-keyed method that sets a mob's origin (`"room"` | `"campaign"`). Only
 * {@link Room.placeMob} and the {@link EncounterTable} spawn path call it.
 */
export const SET_ORIGIN = Symbol("setOrigin");
```

- [ ] **Step 2: Write the failing `Loot[STASH_DROP]` test**

In `src/lib/loot.test.ts`, add `STASH_DROP` to the inventory import and a test. The existing `makeItem` stub supports `CLAIM`/`HELD_BY`; add a small key-stub helper inline.

Update the import line:

```ts
import { CLAIM, STASH_DROP, createKey, type IItem, type ItemId } from "./inventory";
```

Add this `describe` block:

```ts
  describe("STASH_DROP", () => {
    it("forces a key into the box and claims it, bypassing the key guard", () => {
      const loot = new Loot("remains", []);
      const key = createKey({ name: "Vault Key", keyCode: "vault", consumeOnUse: false });

      loot[STASH_DROP](key);

      expect(loot.contents).toContain(key);
      expect(heldBy(key)).toBe(loot);
    });

    it("stashes past the normal capacity", () => {
      const loot = new Loot("remains", [makeItem(), makeItem()]); // capacity 4
      // Fill to capacity, then force one more in.
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());
      const extra = makeItem();

      expect(() => loot[STASH_DROP](extra)).not.toThrow();
      expect(loot.contents).toContain(extra);
    });
  });
```

Run: `npx vitest run src/lib/loot.test.ts`
Expected: FAIL — `loot[STASH_DROP]` is not a function.

- [ ] **Step 3: Implement `Loot[STASH_DROP]`**

In `src/lib/loot.ts`, add `STASH_DROP` to the inventory import:

```ts
import { CLAIM, IItem, IItemHolder, ItemId, STASH_DROP } from "./inventory";
```

Declare it on the `ILoot` interface (after `stowItem`):

```ts
  /**
   * Forces `item` into the container — including a key, and past capacity —
   * claiming it. Engine-internal defeat-drop seam; players use {@link stowItem}.
   */
  [STASH_DROP]: (item: IItem) => void;
```

Implement it on the `Loot` class (after `stowItem`):

```ts
  [STASH_DROP](item: IItem) {
    this.contents.push(item);
    item[CLAIM](this);
  }
```

- [ ] **Step 4: Write the failing `Character[PLACE]` test**

In `src/lib/character/character.test.ts`, add `PLACE` to the inventory import:

```ts
import { CLAIM, Item, PLACE, createKey, type IItem, type ItemId } from "../inventory";
```

The file's `makeRoom()` stub only fakes `enterRoom`/`exitRoom`. Add a test that uses it:

```ts
  describe("PLACE seam", () => {
    it("sets the current room and enters it without recording history", () => {
      const character = makeCharacter();
      const room = makeRoom();

      character[PLACE](room);

      expect(character.currentRoom).toBe(room);
      expect(room.enterRoom).toHaveBeenCalledWith(character);
      expect(character.history).toHaveLength(0);
    });

    it("exits the previous room before entering the new one", () => {
      const character = makeCharacter();
      const first = makeRoom();
      const second = makeRoom();

      character[PLACE](first);
      character[PLACE](second);

      expect(first.exitRoom).toHaveBeenCalledWith(character);
      expect(character.currentRoom).toBe(second);
    });
  });
```

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — `character[PLACE]` is not a function.

- [ ] **Step 5: Implement `Character[PLACE]`**

In `src/lib/character/character.ts`, add `PLACE` to the inventory import (extend the existing destructured import from `"../inventory"`):

```ts
import { CLAIM, CONSUME_VIA_USE, DEPOSIT_MATERIALS, EQUIP, GRANT_IMMUNITY, IItem, IItemHolder, Inventory, MaterialMap, PLACE, SET_DURABILITY, UNEQUIP } from "../inventory";
```

Declare it on the `ICharacter` interface (near `currentRoom`):

```ts
  /** Wires this character into `room` (current room + occupancy) with no history. */
  [PLACE]: (room: IRoom) => void;
```

Implement it on the `Character` class (place it near `move`):

```ts
  /**
   * Engine-internal placement: sets the current room and occupancy directly,
   * exiting any prior room first. Unlike {@link Character.move} it is ungated,
   * records no history, and ticks no action budget. Used to seat resident or
   * spawned mobs (see {@link Room.placeMob} and the encounter spawn path).
   */
  [PLACE](room: IRoom) {
    if (this.#currentRoom) {
      this.#currentRoom.exitRoom(this);
    }
    this.#currentRoom = room;
    room.enterRoom(this);
  }
```

- [ ] **Step 6: Run tests, typecheck, lint, commit**

Run: `npx vitest run src/lib/loot.test.ts src/lib/character/character.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

```bash
git add src/lib/inventory.ts src/lib/loot.ts src/lib/loot.test.ts src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "feat: STASH_DROP, PLACE, SET_ORIGIN seams"
```

---

## Task 4: Mob origin + drop-on-defeat

The mob loads its `drops` into inventory at construction, tracks an origin via `[SET_ORIGIN]`, and on KO distributes: items → a `Loot` box in the room; key items → that box via `STASH_DROP` (room origin only); materials → the campaign pool.

**Files:**
- Modify: `src/lib/character/mob.ts`
- Test: `src/lib/character/mob.test.ts`

- [ ] **Step 1: Write the failing drop tests**

In `src/lib/character/mob.test.ts`, extend the imports and `makeMob`, then add a `describe` block. Update imports at the top:

```ts
import { Campaign } from "../campaign";
import { Item, createKey, SET_ORIGIN, type IItem, type MaterialMap } from "../inventory";
import { StatType } from "./stats";
```

(Keep existing imports; add any not already present. `Room`, `Status`, `ExitsArg`, `makeStats` are already imported.)

Add a real-item helper and a real-campaign helper near the top of the file:

```ts
function makeDrop(name: string): Item {
  const noop = () => {};
  return new Item(
    { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name },
    { equippable: false, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

// A started real campaign so DEPOSIT_MATERIALS and the material pool work.
function realCampaign(): Campaign {
  return new Campaign("Test");
}
```

Extend `makeMob` to forward drops, materials, baseEscapeChance, and an optional campaign:

```ts
function makeMob(
  opts: {
    actionsPerRound?: number;
    drops?: IItem[];
    materialDrops?: MaterialMap;
    stats?: Partial<Stats>;
    rng?: () => number;
    campaign?: Campaign;
  } = {},
) {
  return new Mob(
    opts.campaign ?? makeCampaign(),
    "Goblin",
    makeStats(opts.stats),
    2,
    opts.actionsPerRound ?? 2,
    opts.drops ?? [],
    { rng: opts.rng, materialDrops: opts.materialDrops },
  );
}
```

Add the drop tests:

```ts
  describe("drop-on-defeat", () => {
    function room() {
      return new Room("Lair", "Lair", [], {} as ExitsArg);
    }

    it("spawns a loot box of its items in the room on KO", () => {
      const sword = makeDrop("Sword");
      const lair = room();
      const mob = makeMob({ drops: [sword], stats: { [StatType.Health]: 0 } });
      lair.placeMob(mob);

      mob.takeDamage(0); // reconcile -> KO

      const boxes = [...lair.loot.values()];
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.contents).toContain(sword);
      expect(mob.inventory.items).not.toContain(sword);
    });

    it("deposits material drops into the campaign pool on KO", () => {
      const campaign = realCampaign();
      const mob = makeMob({
        campaign,
        materialDrops: { metal: 3 },
        stats: { [StatType.Health]: 0 },
      });
      room().placeMob(mob);

      mob.takeDamage(0);

      expect(campaign.materials.metal).toBe(3);
    });

    it("drops a key item into the loot box for a room-origin mob", () => {
      const key = createKey({ name: "Cell Key", keyCode: "cell", consumeOnUse: false });
      const lair = room();
      const mob = makeMob({ drops: [key], stats: { [StatType.Health]: 0 } });
      lair.placeMob(mob); // origin = "room"

      mob.takeDamage(0);

      const box = [...lair.loot.values()][0]!;
      expect(box.contents).toContain(key);
    });

    it("does NOT drop a key item for a campaign-origin mob", () => {
      const key = createKey({ name: "Cell Key", keyCode: "cell", consumeOnUse: false });
      const lair = room();
      const mob = makeMob({ drops: [key], stats: { [StatType.Health]: 0 } });
      lair.placeMob(mob);
      mob[SET_ORIGIN]("campaign"); // simulate a roving mob

      mob.takeDamage(0);

      const boxes = [...lair.loot.values()];
      expect(boxes.flatMap((b) => b.contents)).not.toContain(key);
    });

    it("deposits materials but creates no box when KO'd in no room", () => {
      const campaign = realCampaign();
      const mob = makeMob({
        campaign,
        drops: [makeDrop("Sword")],
        materialDrops: { glass: 1 },
        stats: { [StatType.Health]: 0 },
      });

      mob.takeDamage(0); // currentRoom is null

      expect(campaign.materials.glass).toBe(1);
      expect(mob.currentRoom).toBeNull();
    });

    it("creates no loot box when there are no item drops", () => {
      const lair = room();
      const mob = makeMob({ stats: { [StatType.Health]: 0 } });
      lair.placeMob(mob);

      mob.takeDamage(0);

      expect([...lair.loot.values()]).toHaveLength(0);
    });

    it("drops exactly once", () => {
      const lair = room();
      const mob = makeMob({ drops: [makeDrop("Sword")], stats: { [StatType.Health]: 0 } });
      lair.placeMob(mob);

      mob.takeDamage(0);
      mob.takeDamage(0); // still KO — must not drop again

      expect([...lair.loot.values()]).toHaveLength(1);
    });
  });
```

Run: `npx vitest run src/lib/character/mob.test.ts`
Expected: FAIL — `placeMob` does not exist on `Room`, drops are never loaded, and `onKnockOut` is not overridden. (Some failures resolve only once Task 5's `placeMob` lands; that is expected — see Step 3's note. To verify Task 4 in isolation, the implementer may temporarily seat the mob with `mob[PLACE](lair)` instead of `lair.placeMob(mob)`, then switch to `placeMob` after Task 5. Prefer ordering: do Task 5 before re-running this file, OR seat via `[PLACE]` + `mob[SET_ORIGIN]("room")` here.)

> **Sequencing note:** `Room.placeMob` is built in Task 5. To keep Task 4 self-contained, seat the mob in these tests with `mob[SET_ORIGIN]("room"); mob[PLACE](lair);` and switch the two `placeMob` call sites to that form. After Task 5, they can stay as-is (both paths are equivalent for a room-origin mob). The plan below assumes the `[PLACE]`/`[SET_ORIGIN]` form for Task 4's tests; update to `placeMob` in Task 5 if desired.

Rewrite the two seating lines in the tests above to:

```ts
      mob[SET_ORIGIN]("room");
      mob[PLACE](lair);
```

(and import `PLACE` from `"../inventory"` alongside `SET_ORIGIN`).

- [ ] **Step 2: Implement origin, drop-loading, and `onKnockOut` on `Mob`**

Rewrite `src/lib/character/mob.ts`. Full file:

```ts
import { ICampaign } from "../campaign";
import {
  DEPOSIT_MATERIALS,
  IItem,
  MaterialMap,
  SET_ORIGIN,
  STASH_DROP,
} from "../inventory";
import { Loot } from "../loot";
import { roll } from "../dice";
import { clamp } from "../util";
import { Combatant, ICombatant } from "./combatant";
import { Stats, StatType } from "./stats";
import type { AfflictionConfig } from "./afflictions";

/** Where a mob comes from; gates key-item drops (see {@link Mob.onKnockOut}). */
export type MobOrigin = "room" | "campaign" | "unbound";

/** A non-player {@link ICombatant}, such as an enemy, that can also flee. */
export interface IMob extends ICombatant {
  /** Attempts a Health-gated flee through a random exit, recording an `escape`. */
  escape: () => void;
  /** Sets the mob's origin. Engine-internal; see {@link SET_ORIGIN}. */
  [SET_ORIGIN]: (origin: MobOrigin) => void;
}

/**
 * A hostile, non-player combatant. Carries `drops` (loaded into its inventory
 * and released on defeat) plus optional `materialDrops`, can {@link Mob.escape},
 * and distributes loot automatically when KO'd (see {@link Mob.onKnockOut}).
 */
export class Mob extends Combatant implements IMob {
  #origin: MobOrigin = "unbound";
  #baseEscapeChance: number;
  #materialDrops: MaterialMap;

  /**
   * @param campaign - The campaign the mob belongs to.
   * @param name - Display name.
   * @param stats - Initial {@link Stats}.
   * @param inventorySlots - Inventory capacity; raised to fit `drops`. Defaults to 2.
   * @param actionsPerRound - Budgeted actions per turn. Defaults to 2.
   * @param drops - Items the mob carries and releases on defeat.
   * @param options - rng, affliction config, base escape chance, and material drops.
   */
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 2,
    actionsPerRound: number = 2,
    drops: IItem[],
    options: {
      rng?: () => number;
      afflictionConfig?: AfflictionConfig;
      baseEscapeChance?: number;
      materialDrops?: MaterialMap;
    } = {},
  ) {
    const _inventorySlots = Math.max(inventorySlots, drops.length);
    super(campaign, name, stats, _inventorySlots, actionsPerRound, options);

    this.#baseEscapeChance = options.baseEscapeChance ?? 50;
    this.#materialDrops = options.materialDrops ?? {};
    // Load drops into the inventory so "what the mob carries" IS its loot.
    for (const drop of drops) {
      this.receiveItem(drop);
    }

    this.isActionMap.set(this.escape, true);
  }

  /** Sets the mob's origin. Engine-internal seam. */
  [SET_ORIGIN](origin: MobOrigin) {
    this.#origin = origin;
  }

  /**
   * Attempts a Health-gated flee. Success requires both
   * `roll(100) <= clamp(baseEscapeChance + effective Health, 0, 100)` and an
   * available exit; on success the mob moves through a random exit
   * (gate-suppressed). The `escape` action is recorded and the budget ticks
   * either way.
   */
  escape() {
    if (!this.attemptAction(this.escape, false)) return;
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const threshold = clamp(
      this.#baseEscapeChance + this.effectiveStat(StatType.Health),
      0,
      100,
    );
    const success = roll(100, this.rng) <= threshold && exits.length > 0;
    if (success) {
      const destination = exits[roll(exits.length, this.rng) - 1]!;
      this.withGateSuppressed(() => this.move(destination));
    }
    this.recordAction(this.escape, { kind: "escape", success });
  }

  /**
   * On defeat, distributes drops: material drops go to the campaign pool; held
   * items spawn a {@link Loot} box in the current room; key items are stashed
   * into that box only when the mob is room-attached (`origin === "room"`).
   * Does nothing with items if the mob is in no room (materials still deposit).
   */
  protected onKnockOut() {
    if (Object.keys(this.#materialDrops).length > 0) {
      this.campaign[DEPOSIT_MATERIALS](this.#materialDrops);
    }

    const room = this.currentRoom;
    if (!room) return;

    const items = [...this.inventory.items];
    const keys = this.#origin === "room" ? [...this.inventory.keys] : [];
    if (items.length === 0 && keys.length === 0) return;

    for (const item of items) {
      this.relinquishItem(item);
    }
    const box = new Loot(`${this.name}'s remains`, items);

    for (const key of keys) {
      this.relinquishItem(key);
      box[STASH_DROP](key);
    }

    room.loot.set(box.id, box);
  }
}
```

- [ ] **Step 3: Run the mob tests**

Run: `npx vitest run src/lib/character/mob.test.ts`
Expected: PASS (using the `[PLACE]`/`[SET_ORIGIN]` seating form from Step 1).

- [ ] **Step 4: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/lib/character/mob.ts src/lib/character/mob.test.ts
git commit -m "feat: mobs load drops and distribute loot/materials/keys on KO"
```

---

## Task 5: Room placement + the EncounterTable unit

`Room` gains `spawnModifier`, a resident `mobs` constructor param, and `placeMob`. A new `EncounterTable` owns formations, weighted selection, the spawn roll, and visited-room tracking.

**Files:**
- Create: `src/lib/encounter-table.ts`, `src/lib/encounter-table.test.ts`
- Modify: `src/lib/room.ts`
- Test: `src/lib/room.test.ts`

- [ ] **Step 1: Write the failing `Room.placeMob` test**

In `src/lib/room.test.ts`, add a test. (Use the real `Mob`; build it with a stub campaign via `makeCampaign`.) Add imports as needed:

```ts
import { Mob } from "./character/mob";
import { makeCampaign, makeStats } from "../test-utils";
import { SET_ORIGIN } from "./inventory";
```

```ts
  describe("placeMob", () => {
    function makeMob() {
      return new Mob(makeCampaign(), "Goblin", makeStats(), 2, 2, []);
    }

    it("seats the mob as an occupant in its current room with room origin", () => {
      const room = new Room("Lair", "Lair", [], {} as ExitsArg);
      const mob = makeMob();

      room.placeMob(mob);

      expect(room.occupants).toContain(mob);
      expect(mob.currentRoom).toBe(room);
    });

    it("seats resident mobs passed to the constructor", () => {
      const mob = makeMob();
      const room = new Room("Lair", "Lair", [], {} as ExitsArg, [], 1, [mob]);

      expect(room.occupants).toContain(mob);
      expect(mob.currentRoom).toBe(room);
    });

    it("defaults spawnModifier to 1", () => {
      const room = new Room("Hall", "Hall", [], {} as ExitsArg);
      expect(room.spawnModifier).toBe(1);
    });
  });
```

(If `room.test.ts` already imports `ExitsArg`, reuse it; otherwise add `import type { ExitsArg } from "../test-utils";`.)

Run: `npx vitest run src/lib/room.test.ts`
Expected: FAIL — `placeMob`/`spawnModifier` do not exist.

- [ ] **Step 2: Implement Room changes**

In `src/lib/room.ts`:

Add imports:

```ts
import { PLACE, SET_ORIGIN } from "./inventory";
import type { IMob } from "./character/mob";
```

Extend the `IRoom` interface (after `exits`):

```ts
  /** Multiplier on the campaign's base encounter chance (0 = never spawns). */
  spawnModifier: number;
```

and (after `removeExit`):

```ts
  /** Seats `mob` as a room-attached resident (origin `"room"`). */
  placeMob: (mob: IMob) => void;
```

Add the field to the class (with the other fields):

```ts
  spawnModifier: number;
```

Change the constructor signature and body. New signature:

```ts
  constructor(
    name: string,
    description: string,
    loot: ILoot[],
    exits: Record<Direction, IRoom>,
    materials: IMaterialCache[] = [],
    spawnModifier: number = 1,
    mobs: IMob[] = [],
  ) {
```

At the end of the constructor (after the exits loop), add:

```ts
    this.spawnModifier = spawnModifier;

    for (const mob of mobs) {
      this.placeMob(mob);
    }
```

Add the method (after `removeExit`):

```ts
  /**
   * Seats `mob` as a room-attached resident: marks its origin `"room"` and wires
   * it into this room as an occupant. Room-attached mobs may drop key items on
   * defeat (see {@link Mob.onKnockOut}).
   */
  placeMob(mob: IMob) {
    mob[SET_ORIGIN]("room");
    mob[PLACE](this);
  }
```

- [ ] **Step 3: Run room tests**

Run: `npx vitest run src/lib/room.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing EncounterTable tests**

Create `src/lib/encounter-table.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { Campaign } from "./campaign";
import { EncounterTable, type Formation } from "./encounter-table";
import { Mob } from "./character/mob";
import { Room } from "./room";
import { Status } from "./status";
import { createKey } from "./inventory";
import { ProceduralViolation } from "./util";
import { StatType } from "./character/stats";
import { makeStats, type ExitsArg } from "../test-utils";

function goblinFormation(id: string, weight: number): Formation {
  return {
    id,
    weight,
    build: (campaign) => [new Mob(campaign, `Goblin-${id}`, makeStats(), 2, 2, [])],
  };
}

function room(modifier = 1): Room {
  return new Room("Cave", "Cave", [], {} as ExitsArg, [], modifier);
}

describe("EncounterTable", () => {
  describe("addFormation", () => {
    it("rejects a formation whose mobs carry key-item drops", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      const formation: Formation = {
        id: "thief",
        weight: 1,
        build: (c) => [
          new Mob(c, "Thief", makeStats(), 2, 2, [
            createKey({ name: "Loot Key", keyCode: "loot", consumeOnUse: false }),
          ]),
        ],
      };

      expect(() => table.addFormation(formation, campaign)).toThrow(ProceduralViolation);
    });

    it("accepts a formation with no key drops", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      expect(() => table.addFormation(goblinFormation("a", 1), campaign)).not.toThrow();
    });
  });

  describe("maybeSpawn", () => {
    it("spawns into the room when the roll passes on first visit", () => {
      const table = new EncounterTable(() => 0, 50); // roll 1 <= 50*1
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room(1);

      const spawned = table.maybeSpawn(cave, campaign);

      expect(spawned).toHaveLength(1);
      expect(cave.occupants).toContain(spawned[0]);
      expect(spawned[0]!.currentRoom).toBe(cave);
    });

    it("does not spawn on a revisit", () => {
      const table = new EncounterTable(() => 0, 50);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room();

      table.maybeSpawn(cave, campaign); // first visit consumes the chance
      const second = table.maybeSpawn(cave, campaign);

      expect(second).toHaveLength(0);
    });

    it("does not spawn when the roll fails", () => {
      const table = new EncounterTable(() => 0.99, 50); // roll 100 > 50
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);

      expect(table.maybeSpawn(room(), campaign)).toHaveLength(0);
    });

    it("never spawns in a safe room (spawnModifier 0)", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);

      expect(table.maybeSpawn(room(0), campaign)).toHaveLength(0);
    });

    it("suppresses spawning when an active mob is already present", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room();
      cave.placeMob(new Mob(campaign, "Resident", makeStats(), 2, 2, []));

      expect(table.maybeSpawn(cave, campaign)).toHaveLength(0);
    });

    it("marks spawned mobs with campaign origin (no key drops)", () => {
      // A campaign-origin mob must not drop keys: build one with a non-key drop,
      // confirm it is placed with currentRoom set (origin exercised in mob tests).
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room();

      const [mob] = table.maybeSpawn(cave, campaign);

      expect(mob!.status).not.toContain(Status.KO);
      expect(mob!.currentRoom).toBe(cave);
    });
  });
});
```

Run: `npx vitest run src/lib/encounter-table.test.ts`
Expected: FAIL — `./encounter-table` does not exist.

- [ ] **Step 5: Implement the EncounterTable**

Create `src/lib/encounter-table.ts`:

```ts
import { roll } from "./dice";
import { PLACE, SET_ORIGIN } from "./inventory";
import { Status } from "./status";
import { clamp, ProceduralViolation } from "./util";
import type { ICampaign } from "./campaign";
import type { ICharacter } from "./character/character";
import type { IMob } from "./character/mob";
import type { IRoom } from "./room";

/**
 * A roving encounter: a weighted entry in an {@link EncounterTable}. `build`
 * mints FRESH mobs each spawn (a reusable pool cannot hand out the same KO'd
 * instances twice) and should inject the campaign rng into the mobs it builds.
 */
export interface Formation {
  /** Stable identifier. */
  id: string;
  /** Relative selection weight (higher = more likely). */
  weight: number;
  /** Factory that builds this formation's mobs for one spawn. */
  build: (campaign: ICampaign) => IMob[];
}

/**
 * Owns a campaign's roving {@link Formation}s and decides, on first entry to a
 * room, whether one spawns. All randomness routes through the injected `rng`.
 */
export class EncounterTable {
  #formations: Formation[] = [];
  #visited = new Set<string>();
  #rng: () => number;
  #baseChance: number;

  /**
   * @param rng - Float source in `[0, 1)` driving spawn and selection rolls.
   * @param baseChance - Base encounter chance (0–100) before the room modifier.
   */
  constructor(rng: () => number, baseChance: number) {
    this.#rng = rng;
    this.#baseChance = baseChance;
  }

  /**
   * Registers a formation. Rejects one whose mobs carry key-item drops: roving
   * mobs may not drop keys (only room-attached mobs can). Validation mints one
   * sample via `build` and inspects the produced mobs' keyrings.
   *
   * @throws {@link ProceduralViolation} if any sampled mob carries a key drop.
   */
  addFormation(formation: Formation, campaign: ICampaign) {
    for (const mob of formation.build(campaign)) {
      if (mob.inventory.keys.length > 0) {
        throw new ProceduralViolation(
          "A roving formation's mobs cannot drop key items.",
        );
      }
    }
    this.#formations.push(formation);
  }

  /**
   * Decides whether to spawn a formation as a player enters `room`. Rolls only
   * on the first visit (the room is marked visited regardless of outcome) and
   * never when an active mob is already present. On success, a weighted
   * formation is built, marked campaign-origin, and placed in the room.
   *
   * @returns The mobs spawned (empty if none).
   */
  maybeSpawn(room: IRoom, campaign: ICampaign): IMob[] {
    if (this.#visited.has(room.id)) return [];
    this.#visited.add(room.id);

    const activeMobPresent = room.occupants.some(
      (o) =>
        !(campaign.party as ICharacter[]).includes(o) &&
        !o.status.includes(Status.KO),
    );
    if (activeMobPresent) return [];
    if (this.#formations.length === 0) return [];

    const threshold = clamp(this.#baseChance * room.spawnModifier, 0, 100);
    if (roll(100, this.#rng) > threshold) return [];

    const mobs = this.#select().build(campaign);
    for (const mob of mobs) {
      mob[SET_ORIGIN]("campaign");
      mob[PLACE](room);
    }
    return mobs;
  }

  /** Picks a formation weighted by `weight`. */
  #select(): Formation {
    const total = this.#formations.reduce((sum, f) => sum + f.weight, 0);
    let r = roll(total, this.#rng);
    for (const formation of this.#formations) {
      r -= formation.weight;
      if (r <= 0) return formation;
    }
    return this.#formations[this.#formations.length - 1]!;
  }
}
```

> **Note on the `clamp` import:** `clamp` was added to `util.ts` in Task 1. `ProceduralViolation` is already exported from `util.ts`. Import both from `"./util"`.

- [ ] **Step 6: Run tests, typecheck, lint, commit**

Run: `npx vitest run src/lib/encounter-table.test.ts src/lib/room.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

```bash
git add src/lib/room.ts src/lib/room.test.ts src/lib/encounter-table.ts src/lib/encounter-table.test.ts
git commit -m "feat: Room.placeMob/spawnModifier and EncounterTable spawning"
```

---

## Task 6: Campaign integration + player spawn hook

`Campaign` composes an `EncounterTable` (with injected rng + base chance) and exposes `addFormation`/`maybeSpawn`. `PlayerCharacter.move` triggers a spawn check on the room it enters.

**Files:**
- Modify: `src/lib/campaign.ts`, `src/lib/character/player-character.ts`, `src/test-utils.ts`
- Test: `src/lib/campaign.test.ts`, `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Update the `makeCampaign` stub**

In `src/test-utils.ts`, the `Character`/`PlayerCharacter` move path now calls `campaign.maybeSpawn`. Give the bare stub a no-op so existing move tests keep working:

```ts
export function makeCampaign(): ICampaign {
  return {
    maybeSpawn: () => [],
    addFormation: () => {},
  } as unknown as ICampaign;
}
```

- [ ] **Step 2: Write the failing campaign test**

In `src/lib/campaign.test.ts`, add a test (imports: `EncounterTable` is internal — assert via behaviour). Add at the top: `import { Mob } from "./character/mob"; import { Room } from "./room"; import { type Formation } from "./encounter-table"; import { createKey } from "./inventory"; import { makeStats, type ExitsArg } from "../test-utils";`.

> **Type note:** annotate each formation literal as `Formation` and leave its `build` parameter un-annotated. With the literal typed as `Formation`, `build`'s parameter is contextually `ICampaign`; writing `(c: Campaign) => …` instead would trip TypeScript's `strictFunctionTypes` (a `Campaign`-narrowed parameter is not assignable to an `ICampaign` one).

```ts
  describe("encounters", () => {
    const formation: Formation = {
      id: "goblins",
      weight: 1,
      build: (c) => [new Mob(c, "Goblin", makeStats(), 2, 2, [])],
    };

    it("spawns a formation via maybeSpawn when the roll passes", () => {
      const campaign = new Campaign("C", 100, [], { rng: () => 0, baseEncounterChance: 50 });
      campaign.addFormation(formation);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg, [], 1);

      const spawned = campaign.maybeSpawn(cave);

      expect(spawned).toHaveLength(1);
      expect(cave.occupants).toContain(spawned[0]);
    });

    it("rejects a formation whose mobs drop keys", () => {
      const campaign = new Campaign("C", 100, [], { rng: () => 0, baseEncounterChance: 50 });
      const bad: Formation = {
        id: "thief",
        weight: 1,
        build: (c) => [
          new Mob(c, "Thief", makeStats(), 2, 2, [
            createKey({ name: "K", keyCode: "k", consumeOnUse: false }),
          ]),
        ],
      };
      expect(() => campaign.addFormation(bad)).toThrow();
    });
  });
```

Run: `npx vitest run src/lib/campaign.test.ts`
Expected: FAIL — the `Campaign` constructor takes no `options`, and `addFormation`/`maybeSpawn` do not exist.

- [ ] **Step 3: Implement Campaign changes**

In `src/lib/campaign.ts`:

Add imports:

```ts
import { EncounterTable, type Formation } from "./encounter-table";
import type { IRoom } from "./room";
import type { IMob } from "./character/mob";
```

Extend the `ICampaign` interface (in the Methods section):

```ts
  /** Registers a roving formation; rejects one whose mobs drop key items. */
  addFormation: (formation: Formation) => void;
  /** Spawn check for a player entering `room`; returns any mobs spawned. */
  maybeSpawn: (room: IRoom) => IMob[];
```

Add the field to the class:

```ts
  #encounterTable: EncounterTable;
```

Change the constructor signature and body. New signature:

```ts
  constructor(
    title: string,
    maxRounds: number = 100,
    knownRecipes: CraftingRecipe[] = [],
    options: { rng?: () => number; baseEncounterChance?: number } = {},
  ) {
```

Inside the constructor (e.g. just before the `knownRecipes` loop), add:

```ts
    this.#encounterTable = new EncounterTable(
      options.rng ?? Math.random,
      options.baseEncounterChance ?? 20,
    );
```

Add the methods (place near the end of the class):

```ts
  /**
   * Registers a roving {@link Formation}. Delegates to the encounter table,
   * which rejects formations whose mobs carry key-item drops.
   */
  addFormation(formation: Formation) {
    this.#encounterTable.addFormation(formation, this);
  }

  /**
   * Runs the encounter spawn check for a player entering `room` (first-visit
   * only, suppressed when an active mob is present).
   *
   * @returns The mobs spawned, if any.
   */
  maybeSpawn(room: IRoom): IMob[] {
    return this.#encounterTable.maybeSpawn(room, this);
  }
```

- [ ] **Step 4: Write the failing player-character spawn test**

In `src/lib/character/player-character.test.ts`, add a test using a real `Campaign` and real `Room`s. (The file already imports `Campaign`, `Room`, `StatType`, `makeStats`; add `import type { ExitsArg } from "../../test-utils";` if absent.)

```ts
  describe("move triggers encounters", () => {
    it("spawns a formation when entering a new room", () => {
      const campaign = new Campaign("C", 100, [], { rng: () => 0, baseEncounterChance: 50 });
      const pc = new PlayerCharacter(campaign, "Hero", makeStats());
      pc.joinCampaign();
      campaign.gm = pc;
      campaign.beginCampaign();
      campaign.addFormation({
        id: "goblins",
        weight: 1,
        build: (c) => [new Mob(c, "Goblin", makeStats(), 2, 2, [])],
      });
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg, [], 1);

      pc.move(cave);

      const mobsInRoom = cave.occupants.filter((o) => o !== pc);
      expect(mobsInRoom).toHaveLength(1);
    });

    it("does not spawn when the move itself is blocked", () => {
      const campaign = new Campaign("C", 100, [], { rng: () => 0, baseEncounterChance: 100 });
      // A KO'd player cannot move; maybeSpawn must not run for the target room.
      const pc = new PlayerCharacter(campaign, "Hero", makeStats({ [StatType.Health]: 0 }));
      pc.joinCampaign();
      campaign.gm = pc;
      campaign.beginCampaign();
      campaign.addFormation({
        id: "goblins",
        weight: 1,
        build: (c) => [new Mob(c, "Goblin", makeStats(), 2, 2, [])],
      });
      pc.takeDamage(0); // KO
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg, [], 1);

      expect(() => pc.move(cave)).toThrow();
      expect(cave.occupants).toHaveLength(0);
    });
  });
```

Add `import { Mob } from "./mob";` if not already imported.

Run: `npx vitest run src/lib/character/player-character.test.ts`
Expected: FAIL — `move` does not yet call `maybeSpawn`.

- [ ] **Step 5: Override `PlayerCharacter.move`**

In `src/lib/character/player-character.ts`:

Add the import:

```ts
import type { IRoom } from "../room";
```

Add the override (after the constructor, before `joinCampaign`):

```ts
  /**
   * Moves as a {@link Character}, then runs the campaign's encounter spawn check
   * on the room actually entered. If the move was blocked or fizzled (current
   * room unchanged), no spawn check runs.
   *
   * @param room - Destination room.
   */
  move(room: IRoom) {
    super.move(room);
    if (this.currentRoom === room) {
      this.campaign.maybeSpawn(room);
    }
  }
```

- [ ] **Step 6: Run tests, typecheck, lint, commit**

Run: `npx vitest run src/lib/campaign.test.ts src/lib/character/player-character.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts src/lib/character/player-character.ts src/lib/character/player-character.test.ts src/test-utils.ts
git commit -m "feat: campaign formations and player-move encounter spawning"
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (all files). If any pre-existing test broke from the `escape`/`move`/`Room`/`Campaign` signature changes, fix it in place (most likely: an older escape test still using the default rng, or a `new Room(...)`/`new Campaign(...)` call that needs no change since new params default).

```bash
git add -A
git commit -m "test: fix fallout from mob-encounter signature changes" --allow-empty
```

---

## Task 7: Documentation (README + TSDoc sweep)

Per project practice, docs land with the feature.

**Files:**
- Modify: `README.md`
- Review: all files touched above (TSDoc already written inline — verify accuracy)

- [ ] **Step 1: Update the README**

Open `README.md` and locate the mobs/combat and rooms sections. Add a "Mob encounters & loot" subsection covering:
- **Escape** is a Health-gated roll (`baseEscapeChance` + effective Health vs. a d100); a failed escape still costs the action.
- **Drop-on-defeat**: a KO'd mob spawns a loot box of its items in the room, deposits its `materialDrops` into the party pool, and (room-attached mobs only) stashes key items into the box.
- **Origin**: mobs are room-attached (`Room.placeMob` / the room's resident `mobs`) or campaign-roving (formations); only room-attached mobs drop keys.
- **Roving formations**: `Campaign.addFormation` registers a weighted `Formation`; entering a new room runs a first-visit spawn check scaled by `baseEncounterChance × Room.spawnModifier`, suppressed when an active mob is already present.

Match the surrounding prose style. If the README states a test/file count, update it (a new `encounter-table.ts` + `encounter-table.test.ts` were added; recount with `ls src/lib/**/*.test.ts | wc -l` and `npm test` output).

- [ ] **Step 2: Verify the TSDoc**

Skim the public surface added this feature and confirm each carries accurate TSDoc (most written inline above): `clamp`, `Character.onKnockOut`, `Character[PLACE]`, `Loot[STASH_DROP]`, `Mob` (escape, `[SET_ORIGIN]`, `onKnockOut`, `MobOrigin`), `Room.placeMob`/`spawnModifier`, `Formation`, `EncounterTable`, `Campaign.addFormation`/`maybeSpawn`. Fix any drift.

- [ ] **Step 3: Final full-suite run + commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, clean.

```bash
git add README.md
git commit -m "docs: document mob encounters & loot"
```

---

## Final Review

After all tasks, dispatch a final code review over the whole branch (`git diff main...HEAD`) checking: escape determinism under injected rng, the KO hook fires exactly once, key-drop origin rule (authoring rejection + onKnockOut guard), first-visit/no-stacking spawn semantics, and that no pre-existing test regressed. Then use **superpowers:finishing-a-development-branch**.
```
