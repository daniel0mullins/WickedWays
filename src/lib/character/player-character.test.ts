import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ICampaign } from "../campaign";
import type { IItem, ItemId } from "../inventory";
import type { ILoot, LootId } from "../loot";

import { Character, type ICharacter } from "./character";
import { PlayerCharacter } from "./player-character";
import { StatType, type Stats } from "./stats";

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

let itemCounter = 0;
function makeWeapon(opts: {
  equipped?: boolean;
  type?: string;
  stat?: StatType;
  modifier?: number;
} = {}): IItem {
  return {
    id: `item-${++itemCounter}` as ItemId,
    type: opts.type ?? "weapon",
    stat: opts.stat ?? StatType.Health,
    modifier: opts.modifier ?? 1,
    properties: {
      equippable: true,
      equipped: opts.equipped ?? true,
      destroyable: false,
      usable: false,
    },
  } as unknown as IItem;
}

function makeLoot(contents: IItem[]): ILoot {
  return {
    id: "loot-1" as LootId,
    description: "a chest",
    contents,
    spaces: contents.length + 2,
    removeItems: vi.fn(),
    stowItem: vi.fn(),
  } as unknown as ILoot;
}

function makeDefender(): ICharacter {
  return { takeDamage: vi.fn() } as unknown as ICharacter;
}

function makePc(opts: { inventorySlots?: number } = {}) {
  return new PlayerCharacter(
    makeCampaign(),
    "Hero",
    makeStats(),
    opts.inventorySlots,
  );
}

describe("PlayerCharacter", () => {
  beforeEach(() => {
    itemCounter = 0;
  });

  describe("constructor", () => {
    it("is a Character", () => {
      expect(makePc()).toBeInstanceOf(Character);
    });

    it("registers move, attack, and openLootBox as recordable actions", () => {
      const pc = makePc();

      expect(pc.isActionMap.get(pc.move)).toBe(true);
      expect(pc.isActionMap.get(pc.attack)).toBe(true);
      expect(pc.isActionMap.get(pc.openLootBox)).toBe(true);
    });

    it("keeps the inventory actions inherited from Character", () => {
      const pc = makePc();

      expect(pc.isActionMap.get(pc.addToInventory)).toBe(true);
      expect(pc.isActionMap.get(pc.removeFromInventory)).toBe(true);
    });

    it("passes inventory slots through to Character", () => {
      expect(makePc({ inventorySlots: 8 }).inventory.slots).toBe(8);
    });
  });

  describe("attack", () => {
    it("makes a 1-point unarmed health attack when no weapon is equipped", () => {
      const pc = makePc();
      const defender = makeDefender();

      pc.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
    });

    it("uses an equipped weapon's modifier and target stat", () => {
      const pc = makePc();
      pc.inventory.items.push(
        makeWeapon({ stat: StatType.Health, modifier: 3 }),
      );
      const defender = makeDefender();

      pc.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(3, StatType.Health);
    });

    it("does not add the unarmed health point once a weapon is equipped", () => {
      const pc = makePc();
      // A weapon targeting energy means health strength stays 0 and is skipped.
      pc.inventory.items.push(
        makeWeapon({ stat: StatType.Energy, modifier: 2 }),
      );
      const defender = makeDefender();

      pc.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(2, StatType.Energy);
    });

    it("sums the modifiers of multiple weapons targeting the same stat", () => {
      const pc = makePc();
      pc.inventory.items.push(
        makeWeapon({ stat: StatType.Health, modifier: 3 }),
        makeWeapon({ stat: StatType.Health, modifier: 2 }),
      );
      const defender = makeDefender();

      pc.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(5, StatType.Health);
    });

    it("inflicts damage on each targeted stat", () => {
      const pc = makePc();
      pc.inventory.items.push(
        makeWeapon({ stat: StatType.Health, modifier: 3 }),
        makeWeapon({ stat: StatType.Sanity, modifier: 4 }),
      );
      const defender = makeDefender();

      pc.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(2);
      expect(defender.takeDamage).toHaveBeenCalledWith(3, StatType.Health);
      expect(defender.takeDamage).toHaveBeenCalledWith(4, StatType.Sanity);
    });

    it("ignores weapons that are not equipped", () => {
      const pc = makePc();
      pc.inventory.items.push(
        makeWeapon({ equipped: false, stat: StatType.Health, modifier: 9 }),
      );
      const defender = makeDefender();

      pc.attack(defender);

      // Falls back to the unarmed attack.
      expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
    });

    it("ignores equipped items that are not weapons", () => {
      const pc = makePc();
      pc.inventory.items.push(
        makeWeapon({ type: "armor", stat: StatType.Health, modifier: 9 }),
      );
      const defender = makeDefender();

      pc.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
    });

    it("counts as a recordable action", () => {
      const pc = makePc();
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      // The default action budget is 3.
      pc.attack(makeDefender());
      pc.attack(makeDefender());
      expect(onTurnEnd).not.toHaveBeenCalled();

      pc.attack(makeDefender());
      expect(onTurnEnd).toHaveBeenCalledOnce();
    });
  });

  describe("openLootBox", () => {
    it("returns the contents of the loot box", () => {
      const pc = makePc();
      const contents = [makeWeapon(), makeWeapon()];
      const loot = makeLoot(contents);

      expect(pc.openLootBox(loot)).toEqual(contents);
    });

    it("counts as a recordable action", () => {
      const pc = makePc();
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");
      const loot = makeLoot([]);

      pc.openLootBox(loot);
      pc.openLootBox(loot);
      expect(onTurnEnd).not.toHaveBeenCalled();

      pc.openLootBox(loot);
      expect(onTurnEnd).toHaveBeenCalledOnce();
    });
  });
});
