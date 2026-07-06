import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IItem, ItemId } from "../inventory";
import type { IRoom } from "../room";
import type { PresentationCue } from "../presentation";

import { Campaign } from "../campaign";
import { ADD_LIGHT_SOURCE, CLAIM, HELD_BY, Item, PLACE, createKey } from "../inventory";
import { SlotKind } from "../equipment";
import { Loot } from "../loot";
import { ProceduralViolation } from "../util";
import { Character } from "./character";
import { PlayerCharacter } from "./player-character";
import { StatType } from "./stats";
import type { Stats } from "./stats";
import { Status } from "../status";
import type { Archetype, ArchetypeId } from "../archetype";

import { assignNeutralArchetype, makeCampaign, makeDefender, makeStats, setStartingStats } from "../../test-utils";
import { Mob } from "./mob";
import { Room } from "../room";

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
  return new Item({
      descriptor: {
      type: "weapon",
      recipe: { metal: 2 },
      modifier: opts.modifier ?? 3,
      stat: opts.stat ?? StatType.Health,
      name: "Sword",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
      properties: { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
}

function makeDurableArmor(opts: {
  modifier?: number;
  stat?: StatType;
  maxDurability: number;
  durability?: number;
  equipped?: boolean;
}): Item {
  const noop = () => {};
  return new Item({
      descriptor: {
      type: "armor",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: opts.stat ?? StatType.Health,
      name: "Plate",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
      properties: { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
}

// makeHandWeapon builds a real Item with slot: "hand" so Character.equip routes
// it through the equipment slots map (LeftHand / RightHand).
function makeHandWeapon(opts: {
  modifier?: number;
  twoHanded?: boolean;
  name?: string;
}): Item {
  const noop = () => {};
  return new Item({
      descriptor: {
      type: "weapon",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: StatType.Health,
      name: opts.name ?? "Blade",
      slot: "hand",
      twoHanded: opts.twoHanded,
    },
      properties: { equippable: true, equipped: false, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
}

function makePc(opts: { inventorySlots?: number; stats?: Partial<Stats>; rng?: () => number } = {}) {
  const campaign = makeCampaign();
  const pc = new PlayerCharacter({ campaign, name: "Hero", inventorySlots: opts.inventorySlots, rng: opts.rng });
  if (opts.stats) setStartingStats(campaign, pc, opts.stats);
  return pc;
}

// Item stub that supports the holder plumbing (CLAIM + HELD_BY) and pickUp,
// so it works with a real Loot box and with addToInventory.
function makeLootItem(id: string): IItem {
  let holder: unknown = null;
  return {
    id: id as ItemId,
    name: id,
    // Minimal but contract-complete: `properties` is required on IItem and is
    // read by effectiveStat (reached via #reconcile on every turn).
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
// `isLit` is true: a normal, lit room, so the darkness gate never trips here.
function makeRoomWith(box: Loot): IRoom {
  return {
    loot: new Map([[box.id, box]]),
    isLit: true,
    enterRoom: vi.fn(() => []),
    exitRoom: vi.fn(() => []),
  } as unknown as IRoom;
}

// Build a player already standing in a room that holds the box.
function makePcInRoomWith(
  box: Loot,
  opts: { inventorySlots?: number; actionsPerRound?: number } = {},
) {
  const pc = new PlayerCharacter({ campaign: makeCampaign(), name: "Hero", inventorySlots: opts.inventorySlots });
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

    it("defaults every stat to 10 (no stats argument; archetype is the only seam)", () => {
      const pc = new PlayerCharacter({ campaign: makeCampaign(), name: "Hero" });

      expect(pc.stats[StatType.Health]).toBe(10);
      expect(pc.stats[StatType.Sanity]).toBe(10);
      expect(pc.stats[StatType.Energy]).toBe(10);
    });
  });

  describe("codex (rooms)", () => {
    it("records the room a party member moves into", () => {
      const campaign = new Campaign({ title: "Codex" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      const room = new Room({ name: "Vault", description: "a vault", loot: [] });

      pc.move(room);

      const entry = campaign.codex.rooms[0]!;
      expect(entry.snapshot).toEqual({ name: "Vault", description: "a vault" });
      expect(entry.firstSeen.characterId).toBe(pc.id);
      expect(entry.firstSeen.roomId).toBe(room.id);
    });
  });

  describe("joinCampaign", () => {
    it("adds itself to the campaign party", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });

      pc.joinCampaign();

      expect(campaign.party).toContain(pc);
    });

    it("does not add itself twice", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });

      pc.joinCampaign();
      pc.joinCampaign();

      expect(campaign.party.filter((member) => member === pc)).toHaveLength(1);
    });

    it("can join before the campaign has begun", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });

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
      const campaign = new Campaign({ title: "Seam" });
      const hero = new PlayerCharacter({ campaign, name: "Hero" });
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
      const campaign = new Campaign({ title: "Seam" });
      const hero = new PlayerCharacter({ campaign, name: "Hero" });
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
      const campaign = new Campaign({ title: "Seam" });
      const hero = new PlayerCharacter({ campaign, name: "Hero" });
      const weapon = makeDurableWeapon({ modifier: 3, stat: StatType.Health, maxDurability: 1 });
      hero.inventory.items.push(weapon);

      // Real Character defender so its takeDamage runs armor mitigation/wear.
      // Sanity 5 makes the Health multiplier exactly 1.
      const defender = new Character({ campaign, name: "Ogre", stats: makeStats({ [StatType.Sanity]: 5 }) });
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
      const box = new Loot({ description: "chest", contents: contents });
      const pc = makePcInRoomWith(box);

      expect(pc.openLootBox(box)).toEqual(contents);
    });

    it("returns a view that cannot mutate the box", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const pc = makePcInRoomWith(box);

      const view = pc.openLootBox(box) as IItem[];
      view.push(makeLootItem("x"));

      expect(box.contents).toHaveLength(1);
    });

    it("does not cost an action", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const pc = makePcInRoomWith(box, { actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.openLootBox(box);

      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("throws when the box is not in the player's room", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const pc = new PlayerCharacter({ campaign: makeCampaign(), name: "Hero" });

      expect(() => pc.openLootBox(box)).toThrow(ProceduralViolation);
    });
  });

  describe("takeFromLootBox", () => {
    it("moves a specific item from the box into the inventory", () => {
      const target = makeLootItem("a");
      const box = new Loot({ description: "chest", contents: [target, makeLootItem("b")] });
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
      const box = new Loot({ description: "chest", contents: items });
      const pc = makePcInRoomWith(box, { inventorySlots: 2 });

      const taken = pc.takeFromLootBox(box, items);

      expect(taken).toHaveLength(2);
      expect(pc.inventory.items).toHaveLength(2);
      expect(box.contents).toHaveLength(1);
    });

    it("takes nothing and costs no action when the inventory is full", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const pc = makePcInRoomWith(box, { inventorySlots: 1, actionsPerRound: 1 });
      pc.addToInventory(makeLootItem("filler")); // fills the single slot, ends turn
      pc.startTurn(); // fresh turn for the assertion
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      const taken = pc.takeFromLootBox(box, box.contents[0]!);

      expect(taken).toEqual([]);
      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("skips an item that is not in the box", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const pc = makePcInRoomWith(box);

      expect(pc.takeFromLootBox(box, makeLootItem("ghost"))).toEqual([]);
    });

    it("records exactly one action when items move", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a"), makeLootItem("b")] });
      const pc = makePcInRoomWith(box, { actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.takeFromLootBox(box, box.contents.slice());

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("throws when the box is not co-located", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const pc = new PlayerCharacter({ campaign: makeCampaign(), name: "Hero" });

      expect(() => pc.takeFromLootBox(box, box.contents[0]!)).toThrow(
        ProceduralViolation,
      );
    });
  });

  describe("loot box darkness gate", () => {
    // A real light item; only `emitsLight` (and id) matter to room lighting.
    function makeLight(): Item {
      const noop = () => {};
      return new Item({
      descriptor: { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Candle", slot: SlotKind.Hand, emitsLight: true },
      properties: { equippable: true, equipped: false, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
    }

    // A real authored-dark Room holding `box`, with the PC co-located via [PLACE].
    function darkRoomWith(box: Loot) {
      const room = new Room({ name: "Cellar", description: "dark cellar", loot: [box], dark: true });
      const pc = new PlayerCharacter({ campaign: makeCampaign(), name: "Hero" });
      pc[PLACE](room);
      return { room, pc };
    }

    it("takeFromLootBox throws in an unlit room when the player cannot see in the dark", () => {
      const box = new Loot({ description: "chest", contents: [makeLootItem("a")] });
      const { room, pc } = darkRoomWith(box);

      expect(room.isLit).toBe(false);
      expect(pc.seesInDark).toBe(false);
      expect(() => pc.takeFromLootBox(box, box.contents[0]!)).toThrow(
        ProceduralViolation,
      );
    });

    it("takeFromLootBox succeeds once the dark room is lit", () => {
      const target = makeLootItem("a");
      const box = new Loot({ description: "chest", contents: [target] });
      const { room, pc } = darkRoomWith(box);
      room[ADD_LIGHT_SOURCE](makeLight());

      expect(room.isLit).toBe(true);
      const taken = pc.takeFromLootBox(box, target);
      expect(taken).toEqual([target]);
      expect(pc.inventory.items).toContain(target);
    });

    it("openLootBox is not gated: viewing works in the dark", () => {
      const contents = [makeLootItem("a"), makeLootItem("b")];
      const box = new Loot({ description: "chest", contents: contents });
      const { room, pc } = darkRoomWith(box);

      expect(room.isLit).toBe(false);
      expect(pc.openLootBox(box)).toEqual(contents);
    });
  });

  describe("putInLootBox", () => {
    it("moves a held item into the box", () => {
      const box = new Loot({ description: "chest", contents: [] }); // capacity 2
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
      const box = new Loot({ description: "chest", contents: [makeLootItem("x")] }); // capacity 3, 1 used
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
      const box = new Loot({ description: "chest", contents: [makeLootItem("x"), makeLootItem("y")] });
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
      const box = new Loot({ description: "chest", contents: [] });
      const pc = makePcInRoomWith(box);

      expect(pc.putInLootBox(box, makeLootItem("ghost"))).toEqual([]);
    });

    it("records exactly one action when items move", () => {
      const box = new Loot({ description: "chest", contents: [] });
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
      const box = new Loot({ description: "chest", contents: [] });
      const pc = new PlayerCharacter({ campaign: makeCampaign(), name: "Hero" });

      expect(() => pc.putInLootBox(box, makeLootItem("a"))).toThrow(
        ProceduralViolation,
      );
    });

    it("refuses to put a key into the box", () => {
      const box = new Loot({ description: "chest", contents: [] });
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
      const box = new Loot({ description: "chest", contents: [target] });
      const pc = makePcInRoomWith(box);
      pc.takeFromLootBox(box, target);
      const pickUps = pc.history.filter((e) => e.kind === "pickUp");
      expect(pickUps).toHaveLength(1);
      expect(pickUps[0]).toMatchObject({ items: [{ id: target.id, name: target.name }] });
    });

    it("records a single drop when putting into a loot box", () => {
      const target = makeLootItem("a");
      const box = new Loot({ description: "chest", contents: [] });
      const pc = makePcInRoomWith(box, { inventorySlots: 5 });
      pc.addToInventory(target);
      const before = pc.history.length;
      pc.putInLootBox(box, target);
      const drops = pc.history.slice(before).filter((e) => e.kind === "drop");
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ items: [{ id: target.id, name: target.name }] });
    });
  });

  describe("loot box presentation cues", () => {
    it("attributes a loot-box pickup cue to the container's sound", () => {
      const campaign = new Campaign({ title: "Loot" });
      const item = makeLootItem("coin");
      const box = new Loot({ description: "chest", contents: [item], presentation: { sound: "coins.ogg" } });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      const room = new Room({ name: "Vault", description: "Vault", loot: [box] });
      pc.move(room);
      pc.startTurn();

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      pc.takeFromLootBox(box, item);

      expect(seen).toContainEqual(
        expect.objectContaining({ kind: "action", action: "pickUp", sound: "coins.ogg" }),
      );
    });

    it("attributes a loot-box drop cue to the container's sound", () => {
      const campaign = new Campaign({ title: "Loot" });
      const item = makeLootItem("coin");
      const box = new Loot({ description: "chest", contents: [], presentation: { sound: "coins.ogg" } });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      const room = new Room({ name: "Vault", description: "Vault", loot: [box] });
      pc.move(room);
      pc.startTurn();
      pc.addToInventory(item);

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      pc.putInLootBox(box, item);

      expect(seen).toContainEqual(
        expect.objectContaining({ kind: "action", action: "drop", sound: "coins.ogg" }),
      );
    });
  });

  describe("status consequences — gating", () => {
    it("a Panicked player's attack throws", () => {
      const pc = makePc({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      pc.takeDamage(0, StatType.Sanity); // Panic
      expect(() => pc.attack(makeDefender())).toThrow(/Panicked/);
    });

    it("a Fear'd player's move throws", () => {
      const pc = makePc({ stats: { [StatType.Sanity]: 3 }, rng: () => 0.999 });
      pc.takeDamage(0, StatType.Sanity); // Fear (sanity 3 < 5)
      const box = new Loot({ description: "chest", contents: [] });
      expect(() => pc.move(makeRoomWith(box))).toThrow(/afraid/);
    });

    it("a Panicked player's takeFromLootBox throws", () => {
      const target = makeLootItem("a");
      const box = new Loot({ description: "chest", contents: [target] });
      // Build a panicked player already standing in the room.
      const campaign = makeCampaign();
      const pc = new PlayerCharacter({ campaign, name: "Hero", inventorySlots: 5, rng: () => 0.999 });
      setStartingStats(campaign, pc, { [StatType.Sanity]: 0 });
      pc.move(makeRoomWith(box));
      pc.startTurn();
      pc.takeDamage(0, StatType.Sanity); // reconcile → Panic
      expect(pc.status).toContain(Status.Panic);
      expect(() => pc.takeFromLootBox(box, target)).toThrow(/Panicked/);
    });

    it("a Panicked player's putInLootBox throws", () => {
      const box = new Loot({ description: "chest", contents: [] });
      // Start with normal stats so addToInventory is not blocked,
      // then deplete sanity to trigger Panic before the putInLootBox call.
      const campaign = makeCampaign();
      const pc = new PlayerCharacter({ campaign, name: "Hero", inventorySlots: 5, rng: () => 0.999 });
      setStartingStats(campaign, pc, { [StatType.Sanity]: 5 });
      const item = makeLootItem("a");
      pc.addToInventory(item);           // pick up while still normal
      pc.move(makeRoomWith(box));
      pc.startTurn();
      pc.stats[StatType.Sanity] = 0;
      pc.takeDamage(0, StatType.Sanity); // reconcile → Panic
      expect(pc.status).toContain(Status.Panic);
      expect(() => pc.putInLootBox(box, item)).toThrow(/Panicked/);
    });
  });

  describe("selectArchetype", () => {
    function makeArchetype(overrides: Partial<Archetype> = {}): Archetype {
      return { id: "brawler" as ArchetypeId, name: "Brawler", ...overrides };
    }

    it("layers stat deltas onto the base stats", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      // The archetype overrides the default baseline for the stats it names.
      const brawler = makeArchetype({ baseStats: { [StatType.Health]: 9 } });
      campaign.registerArchetype(brawler);

      pc.selectArchetype(brawler.id);

      expect(pc.stats[StatType.Health]).toBe(9);
      expect(pc.archetype).toBe(brawler);
    });

    it("adds the inventory-slot delta to capacity", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero", inventorySlots: 5 });
      const packer = makeArchetype({ inventorySlots: 2 });
      campaign.registerArchetype(packer);

      pc.selectArchetype(packer.id);

      expect(pc.inventory.slots).toBe(7);
    });

    it("floors resulting inventory capacity at 0", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero", inventorySlots: 1 });
      const burdened = makeArchetype({ inventorySlots: -5 });
      campaign.registerArchetype(burdened);

      pc.selectArchetype(burdened.id);

      expect(pc.inventory.slots).toBe(0);
    });

    it("throws on an unknown archetype id", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });

      expect(() => pc.selectArchetype("ghost" as ArchetypeId)).toThrow(ProceduralViolation);
    });

    it("throws when an archetype is already selected", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      const brawler = makeArchetype();
      campaign.registerArchetype(brawler);
      pc.selectArchetype(brawler.id);

      expect(() => pc.selectArchetype(brawler.id)).toThrow(ProceduralViolation);
    });

    it("throws when the campaign has already begun", () => {
      const campaign = new Campaign({ title: "Quest" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      const brawler = makeArchetype();
      campaign.registerArchetype(brawler);
      pc.joinCampaign();
      pc.selectArchetype(brawler.id);
      campaign.gm = pc;
      campaign.beginCampaign();

      const other: Archetype = { id: "rogue" as ArchetypeId, name: "Rogue" };
      campaign.registerArchetype(other);
      expect(() => pc.selectArchetype(other.id)).toThrow(/begun/);
    });

    it("grants standing immunity to a status the stats would otherwise trigger", () => {
      const campaign = new Campaign({ title: "Quest" });
      // Energy 0 (the archetype overrides the default baseline) would normally
      // latch Confused on reconcile.
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      const stoic = makeArchetype({ baseStats: { [StatType.Energy]: 0 }, immunities: [Status.Confused] });
      campaign.registerArchetype(stoic);
      pc.selectArchetype(stoic.id);

      pc.takeDamage(0, StatType.Energy); // forces a reconcile

      expect(pc.status).not.toContain(Status.Confused);
    });
  });

  describe("move triggers encounters", () => {
    it("spawns a formation when entering a new room", () => {
      const campaign = new Campaign({ title: "C", maxRounds: 100, knownRecipes: [], rng: () => 0, baseEncounterChance: 50 });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      campaign.gm = pc;
      assignNeutralArchetype(campaign, pc);
      campaign.beginCampaign();
      campaign.addFormation({
        id: "goblins",
        weight: 1,
        build: (c) => [new Mob({ campaign: c, name: "Goblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [] })],
      });
      const cave = new Room({ name: "Cave", description: "Cave", loot: [] });

      pc.move(cave);

      const mobsInRoom = cave.occupants.filter((o) => o !== pc);
      expect(mobsInRoom).toHaveLength(1);
    });

    it("does not spawn when the move fizzles (Confused)", () => {
      const campaign = new Campaign({ title: "C", maxRounds: 100, knownRecipes: [], rng: () => 0, baseEncounterChance: 100 });
      // Energy 0 => Confused; the player's own rng => 0 makes the move gate fizzle.
      const pc = new PlayerCharacter({ campaign, name: "Hero", inventorySlots: 5, rng: () => 0 });
      pc.stats[StatType.Energy] = 0;
      pc.joinCampaign();
      campaign.gm = pc;
      assignNeutralArchetype(campaign, pc);
      campaign.beginCampaign();
      campaign.addFormation({
        id: "goblins",
        weight: 1,
        build: (c) => [new Mob({ campaign: c, name: "Goblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [] })],
      });
      pc.takeDamage(0, StatType.Energy); // reconcile -> latch Confused

      const cave = new Room({ name: "Cave", description: "Cave", loot: [] });
      pc.move(cave); // Confused gate fizzles (rng 0): move returns without moving

      expect(pc.currentRoom).not.toBe(cave);
      expect(cave.occupants).toHaveLength(0);
    });

    it("does not spawn when the move itself is blocked", () => {
      const campaign = new Campaign({ title: "C", maxRounds: 100, knownRecipes: [], rng: () => 0, baseEncounterChance: 100 });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.stats[StatType.Health] = 0;
      pc.joinCampaign();
      campaign.gm = pc;
      assignNeutralArchetype(campaign, pc);
      campaign.beginCampaign();
      campaign.addFormation({
        id: "goblins",
        weight: 1,
        build: (c) => [new Mob({ campaign: c, name: "Goblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [] })],
      });
      pc.takeDamage(0); // triggers #reconcile() to latch Status.KO (health already 0)
      const cave = new Room({ name: "Cave", description: "Cave", loot: [] });

      expect(() => pc.move(cave)).toThrow();
      expect(cave.occupants).toHaveLength(0);
    });
  });

  describe("encounter cues", () => {
    it("fires once on first encounter per (character, mob) and not on re-entry", () => {
      const campaign = new Campaign({ title: "Enc" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      const hob = new Mob({ campaign, name: "Hobgoblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [], presentation: { sound: "growl.ogg" } });
      const lair = new Room({ name: "Lair", description: "Lair", loot: [] });
      lair.placeMob(hob);
      const hall = new Room({ name: "Hall", description: "Hall", loot: [] });

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => { if (cue.kind === "encounter") seen.push(cue); });

      pc.startTurn();
      pc.move(lair);   // first encounter → fires
      pc.move(hall);   // leaves
      pc.startTurn();
      pc.move(lair);   // re-entry → no repeat

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "encounter", mob: { name: "Hobgoblin" }, sound: "growl.ogg" });
    });

    it("fires separately for a second character meeting the same mob", () => {
      const campaign = new Campaign({ title: "Enc" });
      const hero = new PlayerCharacter({ campaign, name: "Hero" });
      const ally = new PlayerCharacter({ campaign, name: "Ally" });
      hero.joinCampaign();
      ally.joinCampaign();
      const hob = new Mob({ campaign, name: "Hobgoblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [], presentation: { sound: "growl.ogg" } });
      const lair = new Room({ name: "Lair", description: "Lair", loot: [] });
      lair.placeMob(hob);

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => { if (cue.kind === "encounter") seen.push(cue); });

      hero.startTurn();
      hero.move(lair); // hero's first encounter → fires
      ally.startTurn();
      ally.move(lair); // ally's first encounter with the same mob → fires too

      expect(seen).toHaveLength(2);
    });

    it("does not fire for a KO'd mob", () => {
      const campaign = new Campaign({ title: "Enc" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      const downed = new Mob({ campaign, name: "Husk", stats: makeStats({ [StatType.Health]: 0 }), inventorySlots: 2, actionsPerRound: 2, drops: [] });
      const room = new Room({ name: "Crypt", description: "Crypt", loot: [] });
      room.placeMob(downed);
      // A freshly built mob has not reconciled yet, so KO is not latched until a
      // reconcile runs. A zero-strength hit forces the reconcile (no actual damage)
      // and latches KO from the 0 Health.
      downed.takeDamage(0, StatType.Energy);

      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => { if (cue.kind === "encounter") seen.push(cue); });

      pc.startTurn();
      pc.move(room);

      expect(seen).toHaveLength(0);
    });
  });
});
