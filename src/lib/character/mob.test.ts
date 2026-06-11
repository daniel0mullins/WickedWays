import { describe, expect, it, vi } from "vitest";

import type { IItem } from "../inventory";

import { Room } from "../room";
import { Combatant } from "./combatant";
import { Mob } from "./mob";
import { Status } from "../status";
import { StatType } from "./stats";
import type { Stats } from "./stats";

import {
  type ExitsArg,
  makeCampaign,
  makeDefender,
  makeStats,
} from "../../test-utils";

function makeMob(opts: { actionsPerRound?: number; drops?: IItem[]; stats?: Partial<Stats>; rng?: () => number } = {}) {
  return new Mob(
    makeCampaign(),
    "Goblin",
    makeStats(opts.stats),
    2,
    opts.actionsPerRound ?? 2,
    opts.drops ?? [],
    { rng: opts.rng },
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
