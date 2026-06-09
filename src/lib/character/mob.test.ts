import { describe, expect, it, vi } from "vitest";

import type { IItem } from "../inventory";

import { Room } from "../room";
import { Combatant } from "./combatant";
import { Mob } from "./mob";
import { StatType } from "./stats";

import {
  type ExitsArg,
  makeCampaign,
  makeDefender,
  makeStats,
} from "../../test-utils";

function makeMob(opts: { actionsPerRound?: number; drops?: IItem[] } = {}) {
  return new Mob(
    makeCampaign(),
    "Goblin",
    makeStats(),
    2,
    opts.actionsPerRound ?? 2,
    opts.drops ?? [],
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
  });
});
