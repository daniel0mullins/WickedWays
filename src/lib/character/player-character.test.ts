import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ICampaign } from "../campaign";
import type { IItem, ItemId } from "../inventory";
import type { IRoom } from "../room";

import { CLAIM, HELD_BY } from "../inventory";
import { Loot } from "../loot";
import { ProceduralViolation } from "../util";
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

// Item stub that supports the holder plumbing (CLAIM + HELD_BY) and pickUp,
// so it works with a real Loot box and with addToInventory.
function makeLootItem(id: string): IItem {
  let holder: unknown = null;
  return {
    id: id as ItemId,
    actions: { pickUp: vi.fn() },
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [HELD_BY]() {
      return holder;
    },
  } as unknown as IItem;
}

// A room whose loot map contains `box`, so the player can be co-located with it.
function makeRoomWith(box: Loot): IRoom {
  return {
    loot: new Map([[box.id, box]]),
    enterRoom: vi.fn(),
    exitRoom: vi.fn(),
  } as unknown as IRoom;
}

// Build a player already standing in a room that holds the box.
function makePcInRoomWith(
  box: Loot,
  opts: { inventorySlots?: number; actionsPerRound?: number } = {},
) {
  const pc = new PlayerCharacter(
    makeCampaign(),
    "Hero",
    makeStats(),
    opts.inventorySlots,
  );
  if (opts.actionsPerRound !== undefined) {
    pc.actionsPerRound = opts.actionsPerRound;
  }
  pc.move(makeRoomWith(box)); // sets currentRoom
  pc.startTurn(); // reset the action count consumed by move()
  return pc;
}

describe("PlayerCharacter", () => {
  beforeEach(() => {
    itemCounter = 0;
  });

  describe("constructor", () => {
    it("is a Character", () => {
      expect(makePc()).toBeInstanceOf(Character);
    });

    it("registers move and attack as recordable actions", () => {
      const pc = makePc();

      expect(pc.isActionMap.get(pc.move)).toBe(true);
      expect(pc.isActionMap.get(pc.attack)).toBe(true);
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
    it("returns the contents of a co-located loot box", () => {
      const contents = [makeLootItem("a"), makeLootItem("b")];
      const box = new Loot("chest", contents);
      const pc = makePcInRoomWith(box);

      expect(pc.openLootBox(box)).toEqual(contents);
    });

    it("returns a view that cannot mutate the box", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box);

      const view = pc.openLootBox(box) as IItem[];
      view.push(makeLootItem("x"));

      expect(box.contents).toHaveLength(1);
    });

    it("does not cost an action", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box, { actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.openLootBox(box);

      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("throws when the box is not in the player's room", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = new PlayerCharacter(makeCampaign(), "Hero", makeStats());

      expect(() => pc.openLootBox(box)).toThrow(ProceduralViolation);
    });
  });

  describe("takeFromLootBox", () => {
    it("moves a specific item from the box into the inventory", () => {
      const target = makeLootItem("a");
      const box = new Loot("chest", [target, makeLootItem("b")]);
      const pc = makePcInRoomWith(box);

      const taken = pc.takeFromLootBox(box, target);

      expect(taken).toEqual([target]);
      expect(pc.inventory.items).toContain(target);
      expect(box.contents).not.toContain(target);
      expect(target.actions.pickUp).toHaveBeenCalledWith(pc);
      expect(target[HELD_BY]).toBe(pc);
    });

    it("takes only what fits, leaving the rest in the box", () => {
      const items = [makeLootItem("a"), makeLootItem("b"), makeLootItem("c")];
      const box = new Loot("chest", items);
      const pc = makePcInRoomWith(box, { inventorySlots: 2 });

      const taken = pc.takeFromLootBox(box, items);

      expect(taken).toHaveLength(2);
      expect(pc.inventory.items).toHaveLength(2);
      expect(box.contents).toHaveLength(1);
    });

    it("takes nothing and costs no action when the inventory is full", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box, { inventorySlots: 1, actionsPerRound: 1 });
      pc.addToInventory(makeLootItem("filler")); // fills the single slot, ends turn
      pc.startTurn(); // fresh turn for the assertion
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      const taken = pc.takeFromLootBox(box, box.contents[0]!);

      expect(taken).toEqual([]);
      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("skips an item that is not in the box", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box);

      expect(pc.takeFromLootBox(box, makeLootItem("ghost"))).toEqual([]);
    });

    it("records exactly one action when items move", () => {
      const box = new Loot("chest", [makeLootItem("a"), makeLootItem("b")]);
      const pc = makePcInRoomWith(box, { actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.takeFromLootBox(box, box.contents.slice());

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("throws when the box is not co-located", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = new PlayerCharacter(makeCampaign(), "Hero", makeStats());

      expect(() => pc.takeFromLootBox(box, box.contents[0]!)).toThrow(
        ProceduralViolation,
      );
    });
  });
});
