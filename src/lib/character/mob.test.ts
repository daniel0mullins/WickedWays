import { describe, expect, it, vi } from "vitest";

import type { ICampaign } from "../campaign";
import type { IItem } from "../inventory";

import { Room } from "../room";
import { Combatant } from "./combatant";
import { type ICharacter } from "./character";
import { Mob } from "./mob";
import { StatType, type Stats } from "./stats";

type ExitsArg = ConstructorParameters<typeof Room>[2];

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
    ...overrides,
  };
}

function makeCampaign(): ICampaign {
  return {} as ICampaign;
}

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

function makeDefender(): ICharacter {
  return { takeDamage: vi.fn() } as unknown as ICharacter;
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
      const den = new Room("Den", [], {} as ExitsArg);
      const cave = new Room("Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.currentRoom).toBe(cave);
      expect(cave.occupants).toContain(mob);
      expect(den.occupants).not.toContain(mob);
    });

    it("records escape as an action", () => {
      const mob = makeMob({ actionsPerRound: 1 });
      const den = new Room("Den", [], {} as ExitsArg);
      const cave = new Room("Cave", [], {} as ExitsArg);
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

    it("does not move when the current room has no exits", () => {
      const mob = makeMob();
      const sealed = new Room("Sealed", [], {} as ExitsArg);
      mob.move(sealed);

      mob.escape();

      expect(mob.currentRoom).toBe(sealed);
    });
  });
});
