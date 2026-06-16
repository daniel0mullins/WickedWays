import { describe, expect, it, vi } from "vitest";

import { Campaign } from "../campaign";
import { Item, createKey, PLACE, SET_ORIGIN, type IItem, type MaterialMap } from "../inventory";
import { Room } from "../room";
import { Combatant } from "./combatant";
import { Mob } from "./mob";
import { LIGHT_VULNERABILITY } from "./character";
import { Status } from "../status";
import { StatType } from "./stats";
import type { Stats } from "./stats";
import type { Presentation } from "../presentation";

import {
  type ExitsArg,
  makeCampaign,
  makeDefender,
  makeStats,
} from "../../test-utils";

function makeDrop(name: string): Item {
  const noop = () => {};
  return new Item(
    { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name },
    { equippable: false, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

// A real campaign so DEPOSIT_MATERIALS and the material pool work.
function realCampaign(): Campaign {
  return new Campaign("Test");
}

function makeMob(
  opts: {
    actionsPerRound?: number;
    drops?: IItem[];
    materialDrops?: MaterialMap;
    stats?: Partial<Stats>;
    rng?: () => number;
    campaign?: Campaign;
    lightAverse?: boolean;
  } = {},
) {
  return new Mob(
    opts.campaign ?? makeCampaign(),
    "Goblin",
    makeStats(opts.stats),
    2,
    opts.actionsPerRound ?? 2,
    opts.drops ?? [],
    { rng: opts.rng, materialDrops: opts.materialDrops, lightAverse: opts.lightAverse },
  );
}

describe("Mob", () => {
  describe("constructor", () => {
    it("is a Combatant", () => {
      expect(makeMob()).toBeInstanceOf(Combatant);
    });

    it("registers attack and escape as recordable actions", () => {
      const mob = makeMob();

      expect(mob.isActionMap.get(mob.attack)).toBe(true);
      expect(mob.isActionMap.get(mob.escape)).toBe(true);
    });
  });

  describe("attack", () => {
    it("makes a 1-point unarmed health attack inherited from Combatant", () => {
      const mob = makeMob();
      const defender = makeDefender();

      mob.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
    });

    it("a Panicked mob's attack throws", () => {
      const mob = makeMob({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      mob.takeDamage(0, StatType.Sanity); // Panic
      expect(() => mob.attack(makeDefender())).toThrow(/Panicked/);
    });
  });

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
      expect(mob.history.at(-1)).toMatchObject({ kind: "escape", success: false });
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

    it("uses a custom baseEscapeChance in the threshold", () => {
      // baseEscapeChance(10) + Health(10) = 20; rng()=>0.5 rolls 51 (> 20) => fail.
      const mob = new Mob(
        makeCampaign(),
        "Goblin",
        makeStats(),
        2,
        2,
        [],
        { rng: () => 0.5, baseEscapeChance: 10 },
      );
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.currentRoom).toBe(den);
      expect(mob.history.at(-1)).toMatchObject({ kind: "escape", success: false });
    });
  });

  describe("drop-on-defeat", () => {
    function room() {
      return new Room("Lair", "Lair", [], {} as ExitsArg);
    }

    it("spawns a loot box of its items in the room on KO", () => {
      const sword = makeDrop("Sword");
      const lair = room();
      const mob = makeMob({ drops: [sword], stats: { [StatType.Health]: 0 } });
      mob[SET_ORIGIN]("room");
      mob[PLACE](lair);

      mob.takeDamage(0); // reconcile -> KO

      const boxes = [...lair.loot.values()];
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.contents).toContain(sword);
      expect(mob.inventory.items).not.toContain(sword);
    });

    it("deposits material drops into the campaign pool on KO", () => {
      const campaign = realCampaign();
      const lair = room();
      const mob = makeMob({
        campaign,
        materialDrops: { metal: 3 },
        stats: { [StatType.Health]: 0 },
      });
      mob[SET_ORIGIN]("room");
      mob[PLACE](lair);

      mob.takeDamage(0);

      expect(campaign.materials.metal).toBe(3);
    });

    it("drops a key item into the loot box for a room-origin mob", () => {
      const key = createKey({ name: "Cell Key", keyCode: "cell", consumeOnUse: false });
      const lair = room();
      const mob = makeMob({ drops: [key], stats: { [StatType.Health]: 0 } });
      mob[SET_ORIGIN]("room");
      mob[PLACE](lair);

      mob.takeDamage(0);

      const box = [...lair.loot.values()][0]!;
      expect(box.contents).toContain(key);
    });

    it("does NOT drop a key item for a campaign-origin mob (key stays on keyring)", () => {
      const coin = makeDrop("Coin");
      const key = createKey({ name: "Cell Key", keyCode: "cell", consumeOnUse: false });
      const lair = room();
      const mob = makeMob({ drops: [coin, key], stats: { [StatType.Health]: 0 } });
      mob[SET_ORIGIN]("campaign"); // simulate a roving mob
      mob[PLACE](lair);

      mob.takeDamage(0);

      const box = [...lair.loot.values()][0]!;
      expect(box.contents).toContain(coin); // the regular item still drops
      expect(box.contents).not.toContain(key); // the key does not
      expect(mob.inventory.keys).toContain(key); // it stays on the mob's keyring
    });

    it("deposits materials but creates no box when KO'd in no room", () => {
      const campaign = realCampaign();
      const mob = makeMob({
        campaign,
        drops: [makeDrop("Sword")],
        materialDrops: { glass: 1 },
        stats: { [StatType.Health]: 0 },
      });
      mob[SET_ORIGIN]("room");

      mob.takeDamage(0); // currentRoom is null

      expect(campaign.materials.glass).toBe(1);
      expect(mob.currentRoom).toBeNull();
    });

    it("creates no loot box when there are no item drops", () => {
      const lair = room();
      const mob = makeMob({ stats: { [StatType.Health]: 0 } });
      mob[SET_ORIGIN]("room");
      mob[PLACE](lair);

      mob.takeDamage(0);

      expect([...lair.loot.values()]).toHaveLength(0);
    });

    it("drops exactly once", () => {
      const lair = room();
      const mob = makeMob({ drops: [makeDrop("Sword")], stats: { [StatType.Health]: 0 } });
      mob[SET_ORIGIN]("room");
      mob[PLACE](lair);

      mob.takeDamage(0);
      mob.takeDamage(0); // still KO — must not drop again

      expect([...lair.loot.values()]).toHaveLength(1);
    });
  });

  describe("presentation", () => {
    it("exposes the supplied presentation and is undefined when omitted", () => {
      const campaign = makeCampaign();
      const pres: Presentation = { image: "hob.png", sound: "growl.ogg" };
      const withPres = new Mob(campaign, "Hobgoblin", makeStats(), 2, 2, [], {
        presentation: pres,
      });
      const without = new Mob(campaign, "Rat", makeStats(), 2, 2, []);

      expect(withPres.presentation).toBe(pres);
      expect(without.presentation).toBeUndefined();
    });
  });

  // A Health attack is mitigated by Sanity (see MitigatorStatType); Sanity 5
  // yields a (10 - 5) * 0.2 = 1.0 multiplier, so raw strength passes through
  // unchanged with no armor — making the light multiplier the only variable.
  // Health is raised to 30 so the amplified 15-point hit lands without the
  // floor-at-0 clamp in #reconcile masking the difference.
  describe("light-averse mob", () => {
    it("seesInDark is true", () => {
      expect(makeMob({ lightAverse: true }).seesInDark).toBe(true);
    });

    it("defaults to not light-averse (seesInDark false)", () => {
      expect(makeMob().seesInDark).toBe(false);
    });

    it("takes LIGHT_VULNERABILITY-amplified damage while its room is lit", () => {
      // non-dark room => always lit; neutral mitigation, no armor => 10 * 1.5 = 15.
      const litRoom = new Room("Hall", "lit hall", [], {} as ExitsArg);
      const mob = makeMob({
        lightAverse: true,
        stats: { [StatType.Sanity]: 5, [StatType.Health]: 30 },
      });
      mob[PLACE](litRoom);
      const before = mob.stats[StatType.Health];

      mob.takeDamage(10, StatType.Health);

      expect(before - mob.stats[StatType.Health]).toBeCloseTo(10 * LIGHT_VULNERABILITY);
    });

    it("takes normal damage while its room is dark/unlit", () => {
      // trailing `true` is the Room ctor's `dark` flag => unlit with no light source.
      const darkRoom = new Room("Cave", "dark cave", [], {} as ExitsArg, [], 1, [], undefined, true);
      const mob = makeMob({
        lightAverse: true,
        stats: { [StatType.Sanity]: 5, [StatType.Health]: 30 },
      });
      mob[PLACE](darkRoom);
      const before = mob.stats[StatType.Health];

      mob.takeDamage(10, StatType.Health);

      expect(before - mob.stats[StatType.Health]).toBeCloseTo(10);
    });

    it("a non-light-averse defender is unaffected by room lit state", () => {
      const litRoom = new Room("Hall", "lit hall", [], {} as ExitsArg);
      const mob = makeMob({
        stats: { [StatType.Sanity]: 5, [StatType.Health]: 30 },
      }); // not light-averse
      mob[PLACE](litRoom);
      const before = mob.stats[StatType.Health];

      mob.takeDamage(10, StatType.Health);

      expect(before - mob.stats[StatType.Health]).toBeCloseTo(10);
    });
  });

  // Mob extends Combatant extends Character, so the full Afflictions lifecycle —
  // stat-derived statuses, action gating, the Confused fizzle, and the per-turn
  // shake-off roll — applies to mobs exactly as it does to player characters.
  describe("status effects apply to mobs", () => {
    it("is KO'd when its health is depleted, blocking all actions", () => {
      const mob = makeMob({ stats: { [StatType.Health]: 0 }, rng: () => 0.999 });
      mob.takeDamage(0); // reconcile -> KO
      expect(mob.status).toContain(Status.KO);
      expect(() => mob.attack(makeDefender())).toThrow(/KO/);
    });

    it("a Confused mob's attack fizzles and records a fumble", () => {
      // Energy depleted => Confused; rng 0 => d100 roll of 1 <= 50 => fizzle.
      const mob = makeMob({ stats: { [StatType.Energy]: 0 }, rng: () => 0 });
      mob.takeDamage(0, StatType.Energy);
      const defender = makeDefender();

      mob.attack(defender);

      expect(defender.takeDamage).not.toHaveBeenCalled();
      expect(mob.history.at(-1)?.kind).toBe("fumble");
    });

    it("a latched status shakes off on the mob's own turn", () => {
      // Fear is 40% on turn 1; rng 0.39 => d100 roll of 40 <= 40 => clears.
      const mob = makeMob({ stats: { [StatType.Sanity]: 3 }, rng: () => 0.39 });
      mob.takeDamage(0, StatType.Sanity); // Fear
      expect(mob.status).toContain(Status.Fear);

      mob.startTurn(); // onTurnStart shake-off roll

      expect(mob.isNormal).toBe(true);
    });
  });
});
