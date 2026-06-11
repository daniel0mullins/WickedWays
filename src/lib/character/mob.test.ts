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
    it("flees to an adjacent room", () => {
      const mob = makeMob();
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
      const mob = makeMob({ actionsPerRound: 1 });
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
      const mob = makeMob({ actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(mob.events, "onTurnEnd");

      expect(() => mob.escape()).not.toThrow();
      expect(mob.currentRoom).toBeNull();
      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("records an escape in history", () => {
      const mob = makeMob();
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.history.some((e) => e.kind === "escape")).toBe(true);
    });

    it("does not move when the current room has no exits", () => {
      const mob = makeMob();
      const sealed = new Room("Sealed", "Sealed", [], {} as ExitsArg);
      mob.move(sealed);

      mob.escape();

      expect(mob.currentRoom).toBe(sealed);
    });

    it("a normal mob's escape still moves through an exit (withGateSuppressed regression)", () => {
      const mob = makeMob();
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.currentRoom).toBe(cave);
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
