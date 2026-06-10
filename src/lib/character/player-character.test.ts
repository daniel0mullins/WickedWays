import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IItem, ItemId } from "../inventory";
import type { IRoom } from "../room";

import { Campaign } from "../campaign";
import { CLAIM, HELD_BY, Item, createKey } from "../inventory";
import { Loot } from "../loot";
import { ProceduralViolation } from "../util";
import { Character } from "./character";
import { PlayerCharacter } from "./player-character";
import { StatType } from "./stats";

import { makeCampaign, makeDefender, makeStats } from "../../test-utils";

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

function makeDurableWeapon(opts: {
  modifier?: number;
  stat?: StatType;
  maxDurability: number;
  durability?: number;
  equipped?: boolean;
}): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 2 },
      modifier: opts.modifier ?? 3,
      stat: opts.stat ?? StatType.Health,
      name: "Sword",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
    { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

function makeDurableArmor(opts: {
  modifier?: number;
  stat?: StatType;
  maxDurability: number;
  durability?: number;
  equipped?: boolean;
}): Item {
  const noop = () => {};
  return new Item(
    {
      type: "armor",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: opts.stat ?? StatType.Health,
      name: "Plate",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
    { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

// makeHandWeapon builds a real Item with slot: "hand" so Character.equip routes
// it through the equipment slots map (LeftHand / RightHand).
function makeHandWeapon(opts: {
  modifier?: number;
  twoHanded?: boolean;
  name?: string;
}): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: StatType.Health,
      name: opts.name ?? "Blade",
      slot: "hand",
      twoHanded: opts.twoHanded,
    },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
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
    name: id,
    // Minimal but contract-complete: `properties` is required on IItem and is
    // read by effectiveStat (reached via #resolveStatuses on every turn).
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
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

    describe("weapon durability", () => {
      it("wears an equipped durable weapon by one per attack", () => {
        const pc = makePc();
        const weapon = makeDurableWeapon({ modifier: 3, maxDurability: 3 });
        pc.inventory.items.push(weapon);
        const defender = makeDefender();

        pc.attack(defender);

        expect(defender.takeDamage).toHaveBeenCalledWith(3, StatType.Health);
        expect(weapon.durability).toBe(2);
      });

      it("breaks a weapon that reaches 0, after its hit lands", () => {
        const pc = makePc();
        const weapon = makeDurableWeapon({ modifier: 3, maxDurability: 1 });
        pc.inventory.items.push(weapon);
        const defender = makeDefender();

        pc.attack(defender);

        expect(defender.takeDamage).toHaveBeenCalledWith(3, StatType.Health);
        expect(weapon.isBroken).toBe(true);
      });

      it("a broken weapon contributes nothing (falls back to unarmed)", () => {
        const pc = makePc();
        pc.inventory.items.push(
          makeDurableWeapon({ modifier: 3, maxDurability: 1, durability: 0 }),
        );
        const defender = makeDefender();

        pc.attack(defender);

        expect(defender.takeDamage).toHaveBeenCalledTimes(1);
        expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
      });

      it("does not wear a non-durable weapon", () => {
        const pc = makePc();
        pc.inventory.items.push(makeWeapon({ modifier: 2, stat: StatType.Health }));
        const defender = makeDefender();

        expect(() => pc.attack(defender)).not.toThrow();
        expect(defender.takeDamage).toHaveBeenCalledWith(2, StatType.Health);
      });

      it("wears each equipped durable weapon independently", () => {
        const pc = makePc();
        const a = makeDurableWeapon({ modifier: 2, stat: StatType.Health, maxDurability: 4 });
        const b = makeDurableWeapon({ modifier: 1, stat: StatType.Health, maxDurability: 4 });
        pc.inventory.items.push(a, b);
        const defender = makeDefender();

        pc.attack(defender);

        expect(a.durability).toBe(3);
        expect(b.durability).toBe(3);
      });
    });

    it("records the attack target in the attacker's history", () => {
      const pc = makePc();
      const defender = makeDefender();
      pc.attack(defender);
      expect(pc.history.at(-1)).toMatchObject({
        kind: "attack",
        target: { id: defender.id, name: defender.name },
      });
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

  describe("equipment seam", () => {
    it("caps attack at hand count — a third weapon displaces one", () => {
      const campaign = new Campaign("Seam");
      const hero = new PlayerCharacter(campaign, "Hero", makeStats());
      const a = makeHandWeapon({ modifier: 2, name: "A" });
      const b = makeHandWeapon({ modifier: 2, name: "B" });
      const c = makeHandWeapon({ modifier: 2, name: "C" });
      [a, b, c].forEach((w) => hero.inventory.items.push(w));

      hero.equip(a);
      hero.equip(b); // both hands full
      hero.equip(c); // displaces the occupant of the first hand (LeftHand)

      const equippedWeapons = hero.inventory.items.filter((w) => w.properties.equipped);
      // The core guarantee: never three weapons equipped simultaneously.
      expect(equippedWeapons).toHaveLength(2);

      // attack sums weapons per stat into a single takeDamage call per stat:
      // two Health weapons (modifier 2 each) → takeDamage(4, Health).
      const defender = makeDefender();
      hero.attack(defender);
      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(4, StatType.Health);
    });

    it("a two-handed weapon yields a single-weapon attack", () => {
      const campaign = new Campaign("Seam");
      const hero = new PlayerCharacter(campaign, "Hero", makeStats());
      const greatsword = makeHandWeapon({ modifier: 5, twoHanded: true, name: "2H" });
      hero.inventory.items.push(greatsword);
      hero.equip(greatsword);

      // A two-handed weapon spans both hand slots but is ONE item in inventory.
      // attack finds it once → single takeDamage(5, Health) call.
      const defender = makeDefender();
      hero.attack(defender);
      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(5, StatType.Health);
    });
  });

  describe("durability seam", () => {
    it("a weapon breaks in combat, is repaired, and fights again while armor wears", () => {
      const campaign = new Campaign("Seam");
      const hero = new PlayerCharacter(campaign, "Hero", makeStats());
      const weapon = makeDurableWeapon({ modifier: 3, stat: StatType.Health, maxDurability: 1 });
      hero.inventory.items.push(weapon);

      // Real Character defender so its takeDamage runs armor mitigation/wear.
      // Sanity 5 makes the Health multiplier exactly 1.
      const defender = new Character(campaign, "Ogre", makeStats({ [StatType.Sanity]: 5 }));
      const armor = makeDurableArmor({ modifier: 2, stat: StatType.Health, maxDurability: 5 });
      defender.inventory.items.push(armor);

      // Swing 1: weapon mod 3 vs armor mod 2 -> raw 1 -> final 1. Weapon breaks; armor wears.
      const start = defender.stats[StatType.Health];
      hero.attack(defender);
      expect(defender.stats[StatType.Health]).toBeCloseTo(start - 1);
      expect(weapon.isBroken).toBe(true);
      expect(armor.durability).toBe(4);

      // Swing 2: broken weapon -> unarmed 1; armor fully soaks it (raw max(0, 1 - 2) = 0).
      const mid = defender.stats[StatType.Health];
      hero.attack(defender);
      expect(defender.stats[StatType.Health]).toBeCloseTo(mid);
      expect(armor.durability).toBe(3);

      // Repair from a stocked pool, then swing effectively again.
      campaign.claimMaterials("seed", { metal: 2 });
      hero.repair(weapon);
      expect(weapon.isBroken).toBe(false);

      hero.attack(defender);
      expect(defender.stats[StatType.Health]).toBeCloseTo(mid - 1);
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

  describe("putInLootBox", () => {
    it("moves a held item into the box", () => {
      const box = new Loot("chest", []); // capacity 2
      const pc = makePcInRoomWith(box, { actionsPerRound: 99 });
      const item = makeLootItem("a");
      pc.addToInventory(item);

      const put = pc.putInLootBox(box, item);

      expect(put).toEqual([item]);
      expect(box.contents).toContain(item);
      expect(pc.inventory.items).not.toContain(item);
      expect(item[HELD_BY]).toBe(box);
    });

    it("puts only what fits, leaving the rest in the inventory", () => {
      const box = new Loot("chest", [makeLootItem("x")]); // capacity 3, 1 used
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 99 });
      const held = [makeLootItem("a"), makeLootItem("b"), makeLootItem("c")];
      pc.addToInventory(held);

      const put = pc.putInLootBox(box, held);

      expect(put).toHaveLength(2); // box had room for 2 more
      expect(box.contents).toHaveLength(3);
      expect(pc.inventory.items).toHaveLength(1);
    });

    it("puts nothing and costs no action when the box is full", () => {
      // Capacity is seeded contents + 2, so fill the remaining slots to make it full.
      const box = new Loot("chest", [makeLootItem("x"), makeLootItem("y")]);
      box.stowItem(makeLootItem("z"));
      box.stowItem(makeLootItem("w"));
      expect(box.contents).toHaveLength(box.capacity); // full
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 1 });
      const item = makeLootItem("a");
      pc.addToInventory(item);
      pc.startTurn();
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      const put = pc.putInLootBox(box, item);

      expect(put).toEqual([]);
      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("skips an item the player is not holding", () => {
      const box = new Loot("chest", []);
      const pc = makePcInRoomWith(box);

      expect(pc.putInLootBox(box, makeLootItem("ghost"))).toEqual([]);
    });

    it("records exactly one action when items move", () => {
      const box = new Loot("chest", []);
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 99 });
      const item = makeLootItem("a");
      pc.addToInventory(item);
      pc.startTurn();
      pc.actionsPerRound = 1;
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.putInLootBox(box, item);

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("throws when the box is not co-located", () => {
      const box = new Loot("chest", []);
      const pc = new PlayerCharacter(makeCampaign(), "Hero", makeStats());

      expect(() => pc.putInLootBox(box, makeLootItem("a"))).toThrow(
        ProceduralViolation,
      );
    });

    it("refuses to put a key into the box", () => {
      const box = new Loot("chest", []);
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 99 });
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });
      pc.addToInventory(key);

      expect(() => pc.putInLootBox(box, key)).toThrow(ProceduralViolation);
      expect(box.contents).not.toContain(key);
    });
  });

  describe("loot box history", () => {
    it("records a single pickUp when taking from a loot box", () => {
      const target = makeLootItem("a");
      const box = new Loot("chest", [target]);
      const pc = makePcInRoomWith(box);
      pc.takeFromLootBox(box, target);
      const pickUps = pc.history.filter((e) => e.kind === "pickUp");
      expect(pickUps).toHaveLength(1);
      expect(pickUps[0]).toMatchObject({ items: [{ id: target.id, name: target.name }] });
    });

    it("records a single drop when putting into a loot box", () => {
      const target = makeLootItem("a");
      const box = new Loot("chest", []);
      const pc = makePcInRoomWith(box, { inventorySlots: 5 });
      pc.addToInventory(target);
      const before = pc.history.length;
      pc.putInLootBox(box, target);
      const drops = pc.history.slice(before).filter((e) => e.kind === "drop");
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ items: [{ id: target.id, name: target.name }] });
    });
  });
});
