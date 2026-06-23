import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM, Item, PLACE, SET_DURABILITY, createKey, type IItem, type ItemId } from "../inventory";
import { EquipmentSlot, SlotKind } from "../equipment";
import type { IRoom, RoomId } from "../room";
import { Status } from "../status";
import { ProceduralViolation } from "../util";

import type { ICampaign } from "../campaign";
import { Character } from "./character";
import { Mob } from "./mob";
import type { ActionHistoryEntry } from "./history";
import { StatType, type Stats } from "./stats";

import type { CraftingRecipe, RecipeId } from "../crafting";
import { makeCampaign, makeStats, assignNeutralArchetype } from "../../test-utils";
import { Campaign } from "../campaign";
import { PlayerCharacter } from "./player-character";
import { Room } from "../room";
import { MaterialCache } from "../material-cache";
import { EMIT_CUE } from "../presentation";
import type { PresentationCue } from "../presentation";
import { ADJUST_STAT } from "../mechanics/symbols";
import type { LiveMechanic } from "../mechanics/mechanic";

// ---------------------------------------------------------------------------
// Test doubles
//
// Rooms and items are interacted with through a small, known surface, so we
// fake just the methods Character touches. Stats and the campaign stub come
// from the shared test-utils helpers.
// ---------------------------------------------------------------------------

let itemCounter = 0;
function makeItem(id?: string): IItem {
  const itemId = (id ?? `item-${++itemCounter}`) as ItemId;
  let holder: unknown = null;
  return {
    id: itemId,
    name: itemId,
    // Minimal but contract-complete: `properties` is required on IItem and is
    // read by effectiveStat (now reached via #reconcile on every turn).
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: vi.fn() },
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [Symbol.for("heldBy")]() {
      return holder;
    },
  } as unknown as IItem;
}

function makeTeachingItem(recipe: CraftingRecipe, id = "teacher"): IItem {
  let holder: unknown = null;
  return {
    id: id as ItemId,
    name: "Blueprint",
    type: "consumable",
    teaches: recipe,
    actions: { pickUp: vi.fn() },
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [Symbol.for("heldBy")]() {
      return holder;
    },
  } as unknown as IItem;
}

function makeRoom(): IRoom {
  return {
    id: "room-1" as RoomId,
    name: "Test Room",
    enterRoom: vi.fn(),
    exitRoom: vi.fn(),
  } as unknown as IRoom;
}

type ItemDescriptor = ConstructorParameters<typeof Item>[0]["descriptor"];
function makeDurable(opts: {
  type?: ItemDescriptor["type"];
  stat?: StatType;
  modifier?: number;
  recipe?: ItemDescriptor["recipe"];
  maxDurability?: number;
  durability?: number;
  equipped?: boolean;
} = {}): Item {
  const noop = () => {};
  return new Item({
      descriptor: {
      type: opts.type ?? "weapon",
      recipe: opts.recipe ?? { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: opts.stat ?? StatType.Health,
      name: "Gear",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
      properties: { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
}

function makeGear(opts: {
  type?: ItemDescriptor["type"];
  name?: string;
  slot?: ItemDescriptor["slot"];
  twoHanded?: boolean;
  stat?: StatType;
  modifier?: number;
  equippable?: boolean;
  usable?: boolean;
  immunities?: Status[];
  grantsImmunity?: { statuses: Status[]; turns: number };
  emitsLight?: boolean;
  maxDurability?: number;
}): Item {
  const noop = () => {};
  return new Item({
      descriptor: {
      type: opts.type ?? "armor",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 1,
      stat: opts.stat ?? StatType.Health,
      name: opts.name ?? "Gear",
      slot: opts.slot,
      twoHanded: opts.twoHanded,
      immunities: opts.immunities,
      grantsImmunity: opts.grantsImmunity,
      emitsLight: opts.emitsLight,
      maxDurability: opts.maxDurability,
    },
      properties: { equippable: opts.equippable ?? true, equipped: false, destroyable: true, usable: opts.usable ?? false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
}

function makeCharacter(opts: {
  stats?: Partial<Stats>;
  inventorySlots?: number;
  actionsPerRound?: number;
  rng?: () => number;
} = {}) {
  return new Character({ campaign: makeCampaign(), name: "Hero", stats: makeStats(opts.stats), inventorySlots: opts.inventorySlots, actionsPerRound: opts.actionsPerRound, rng: opts.rng });
}

// Builds a Hero on a real Campaign and wires the passed array up as a cue sink
// via the public `onCue` subscription, so every cue the character emits through
// `campaign[EMIT_CUE]` is recorded. A real Campaign is used (rather than the
// no-op makeCampaign stub) because its `[EMIT_CUE]` actually dispatches to
// `onCue` handlers — mirroring the existing "action cues" tests.
function makeCharacterWithCueSink(cues: PresentationCue[]): Character {
  const campaign = new Campaign({ title: "Cues" });
  const hero = new Character({ campaign, name: "Hero", stats: makeStats() });
  campaign.onCue((cue) => cues.push(cue));
  return hero;
}

describe("Character", () => {
  beforeEach(() => {
    itemCounter = 0;
  });

  describe("constructor", () => {
    it("assigns a generated id and the provided name and stats", () => {
      const stats = makeStats({ [StatType.Health]: 7 });
      const character = new Character({ campaign: makeCampaign(), name: "Mira", stats });

      expect(typeof character.id).toBe("string");
      expect(character.id.length).toBeGreaterThan(0);
      expect(character.name).toBe("Mira");
      expect(character.stats).toBe(stats);
    });

    it("exposes the campaign passed to the constructor", () => {
      const campaign = makeCampaign();
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });

      expect(character.campaign).toBe(campaign);
    });

    it("defaults inventory to 5 slots and no items", () => {
      const character = makeCharacter();

      expect(character.inventory.slots).toBe(5);
      expect(character.inventory.items).toEqual([]);
    });

    it("honours custom inventory slot and actions-per-round values", () => {
      const character = makeCharacter({ inventorySlots: 2, actionsPerRound: 4 });

      expect(character.inventory.slots).toBe(2);
      expect(character.actionsPerRound).toBe(4);
    });

    it("starts in no room", () => {
      expect(makeCharacter().currentRoom).toBeNull();
    });

    it("starts with no active statuses", () => {
      expect(makeCharacter().status).toEqual([]);
    });

    it("starts in a normal (unafflicted) state", () => {
      expect(makeCharacter().isNormal).toBe(true);
    });

    it("registers inventory mutations as recordable actions", () => {
      const character = makeCharacter();

      expect(character.isActionMap.get(character.addToInventory)).toBe(true);
      expect(character.isActionMap.get(character.removeFromInventory)).toBe(true);
    });
  });

  describe("hasLight", () => {
    it("is false with nothing equipped", () => {
      expect(makeCharacter().hasLight).toBe(false);
    });

    it("is true with an equipped, non-broken light in a hand", () => {
      const hero = makeCharacter();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.equip(torch, EquipmentSlot.LeftHand);
      expect(hero.hasLight).toBe(true);
    });

    it("is false when the only light is broken", () => {
      const hero = makeCharacter();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true, maxDurability: 1 });
      hero.addToInventory(torch);
      hero.equip(torch, EquipmentSlot.LeftHand);
      torch[SET_DURABILITY](0);
      expect(hero.hasLight).toBe(false);
    });
  });

  describe("placeLight / takeLight", () => {
    // Build a real authored-dark Room and co-locate the hero in it via the
    // engine-internal [PLACE] seam, which sets currentRoom + occupancy.
    function darkRoomWithHero() {
      const room = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      const hero = makeCharacter();
      hero[PLACE](room);
      return { room, hero };
    }

    it("placeLight moves a held light into the room and lights it", () => {
      const { room, hero } = darkRoomWithHero();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.placeLight(torch);
      expect(room.lightSources.get(torch.id)).toBe(torch);
      expect(hero.inventory.items.some((i) => i.id === torch.id)).toBe(false);
      expect(room.isLit).toBe(true);
    });

    it("takeLight moves a placed light back into inventory and re-darkens", () => {
      const { room, hero } = darkRoomWithHero();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.placeLight(torch);
      hero.takeLight(torch);
      expect(room.lightSources.has(torch.id)).toBe(false);
      expect(hero.inventory.items.some((i) => i.id === torch.id)).toBe(true);
      expect(room.isLit).toBe(false);
    });

    it("placeLight unequips an equipped hand-light, leaving no phantom equipment", () => {
      const { room, hero } = darkRoomWithHero();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.equip(torch, EquipmentSlot.LeftHand);
      expect(hero.hasLight).toBe(true);

      hero.placeLight(torch);

      // Placed into the room, and fully detached from the character: no slot
      // reference, no lingering equipped flag, no carried-light.
      expect(room.lightSources.get(torch.id)).toBe(torch);
      expect(hero.equipment.get(EquipmentSlot.LeftHand)).toBeUndefined();
      expect(torch.properties.equipped).toBe(false);
      expect(hero.hasLight).toBe(false);
      expect(hero.inventory.items.some((i) => i.id === torch.id)).toBe(false);
    });

    it("placeLight throws for a non-light item", () => {
      const { hero } = darkRoomWithHero();
      const rock = makeGear({ name: "Rock", emitsLight: false });
      hero.addToInventory(rock);
      expect(() => hero.placeLight(rock)).toThrow(ProceduralViolation);
    });

    it("placeLight throws when the character holds no such item", () => {
      const { hero } = darkRoomWithHero();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      expect(() => hero.placeLight(torch)).toThrow(ProceduralViolation);
    });

    it("placeLight throws when not in a room", () => {
      const hero = makeCharacter(); // no room
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      expect(() => hero.placeLight(torch)).toThrow(ProceduralViolation);
    });

    it("takeLight throws when the light is not in the room", () => {
      const { hero } = darkRoomWithHero();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      expect(() => hero.takeLight(torch)).toThrow(ProceduralViolation);
    });

    it("placeLight/takeLight are free actions (record no history)", () => {
      const { hero } = darkRoomWithHero();
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      const before = hero.history.length;
      hero.placeLight(torch);
      hero.takeLight(torch);
      // Free: no history entries and the budget is never touched, so repeated
      // calls never exhaust the budget or throw a budget error.
      expect(hero.history.length).toBe(before);
      expect(() => {
        hero.placeLight(torch);
        hero.takeLight(torch);
      }).not.toThrow();
    });
  });

  describe("addToInventory", () => {
    it("adds a single item and notifies the item it was picked up", () => {
      const character = makeCharacter();
      const item = makeItem();

      character.addToInventory(item);

      expect(character.inventory.items).toEqual([item]);
      expect(item.actions.pickUp).toHaveBeenCalledWith(character);
    });

    it("adds an array of items", () => {
      const character = makeCharacter();
      const items = [makeItem(), makeItem(), makeItem()];

      character.addToInventory(items);

      expect(character.inventory.items).toEqual(items);
    });

    it("throws a ProceduralViolation when there are no free slots", () => {
      const character = makeCharacter({ inventorySlots: 1 });
      character.addToInventory(makeItem());

      expect(() => character.addToInventory(makeItem())).toThrow(
        ProceduralViolation,
      );
    });

    it("adds items up to capacity before throwing on overflow", () => {
      const character = makeCharacter({ inventorySlots: 1, actionsPerRound: 99 });
      const kept = makeItem("kept");
      const overflow = makeItem("overflow");

      expect(() => character.addToInventory([kept, overflow])).toThrow(
        ProceduralViolation,
      );
      expect(character.inventory.items).toEqual([kept]);
    });
  });

  describe("removeFromInventory", () => {
    it("removes a held item", () => {
      const character = makeCharacter({ actionsPerRound: 99 });
      const item = makeItem();
      character.addToInventory(item);

      character.removeFromInventory(item);

      expect(character.inventory.items).toEqual([]);
    });

    it("removes only the matching item and leaves the rest", () => {
      const character = makeCharacter({ actionsPerRound: 99 });
      const a = makeItem("a");
      const b = makeItem("b");
      character.addToInventory([a, b]);

      character.removeFromInventory(a);

      expect(character.inventory.items).toEqual([b]);
    });

    it("removes an array of items", () => {
      const character = makeCharacter({ actionsPerRound: 99 });
      const a = makeItem("a");
      const b = makeItem("b");
      const c = makeItem("c");
      character.addToInventory([a, b, c]);

      character.removeFromInventory([a, c]);

      expect(character.inventory.items).toEqual([b]);
    });

    it("throws a ProceduralViolation when the item is not held", () => {
      const character = makeCharacter();

      expect(() => character.removeFromInventory(makeItem())).toThrow(
        ProceduralViolation,
      );
    });
  });

  describe("takeDamage", () => {
    it("applies no damage when the mitigating stat is maxed", () => {
      // Health is mitigated by Sanity: (10 - sanity) * 0.2 => 0 at sanity 10.
      const character = makeCharacter({ stats: { [StatType.Sanity]: 10 } });

      character.takeDamage(5);

      expect(character.stats[StatType.Health]).toBeCloseTo(10);
    });

    it("scales damage down as the mitigating stat rises", () => {
      // sanity 5 => (10 - 5) * 0.2 = 1 multiplier => 5 damage.
      const character = makeCharacter({
        stats: { [StatType.Health]: 10, [StatType.Sanity]: 5 },
      });

      character.takeDamage(5);

      expect(character.stats[StatType.Health]).toBeCloseTo(5);
    });

    it("can apply damage to a non-default stat", () => {
      // Energy is mitigated by Health: (10 - health) * 0.2 => 1 at health 5.
      const character = makeCharacter({
        stats: { [StatType.Energy]: 8, [StatType.Health]: 5 },
      });

      character.takeDamage(3, StatType.Energy);

      expect(character.stats[StatType.Energy]).toBeCloseTo(5);
    });

    it("clamps health at zero and applies KO when health is depleted", () => {
      const character = makeCharacter({
        stats: { [StatType.Health]: 4, [StatType.Sanity]: 5 },
      });

      // sanity 5 => multiplier 1 => 10 damage against 4 health.
      character.takeDamage(10);

      expect(character.stats[StatType.Health]).toBe(0);
      expect(character.status).toContain(Status.KO);
    });

    it("applies Panic and clamps sanity when sanity is depleted", () => {
      // Sanity is mitigated by Energy; Energy 0 => multiplier (10-0)*0.2 = 2.
      const character = makeCharacter({
        stats: { [StatType.Sanity]: 2, [StatType.Energy]: 0 },
      });

      character.takeDamage(20, StatType.Sanity);

      expect(character.stats[StatType.Sanity]).toBe(0);
      expect(character.status).toContain(Status.Panic);
      expect(character.status).not.toContain(Status.Fear);
    });

    it("applies Fear when sanity is low but not depleted", () => {
      const character = makeCharacter({
        // Energy 0 => sanity mitigator multiplier (10-0)*0.2 = 2.
        stats: { [StatType.Sanity]: 6, [StatType.Energy]: 0 },
      });

      // 1 damage * 2 => 2 => sanity 4 (< 5, > 0).
      character.takeDamage(1, StatType.Sanity);

      expect(character.stats[StatType.Sanity]).toBe(4);
      expect(character.status).toContain(Status.Fear);
      expect(character.status).not.toContain(Status.Panic);
    });

    it("applies Confused and clamps energy when energy is depleted", () => {
      const character = makeCharacter({
        // Energy mitigated by Health 1 => multiplier 1.8; large enough to zero energy.
        // Health stays > 0 after the energy-only hit so KO does not mask Confused.
        stats: { [StatType.Energy]: 3, [StatType.Health]: 1 },
        rng: () => 0.999,
      });

      character.takeDamage(10, StatType.Energy);

      expect(character.stats[StatType.Energy]).toBe(0);
      expect(character.status).toContain(Status.Confused);
    });

    it("leaves Confused unchanged when energy sits at exactly 1", () => {
      // Energy of 1 is the neutral band: not depleted (<= 0) and not yet
      // recovered (> 1), so the Confused status is left as-is.
      const character = makeCharacter({ stats: { [StatType.Energy]: 1 } });

      // Health mitigated by Sanity 10 => zero damage, so energy stays at 1
      // while #reconcile runs over the unchanged stats.
      character.takeDamage(0);

      expect(character.stats[StatType.Energy]).toBe(1);
      expect(character.status).not.toContain(Status.Confused);
    });

    it("is no longer normal once an affliction is applied", () => {
      const character = makeCharacter({
        stats: { [StatType.Health]: 4, [StatType.Sanity]: 5 },
      });

      character.takeDamage(10); // depletes health => KO

      expect(character.status).toContain(Status.KO);
      expect(character.isNormal).toBe(false);
    });

    it("does not count as a recordable action", () => {
      const character = makeCharacter({ actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(character.events, "onTurnEnd");

      character.takeDamage(1);
      character.takeDamage(1);

      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    describe("armor", () => {
      // Sanity 5 makes the Health multiplier exactly 1: (10 - 5) * 0.2 = 1,
      // so post-mitigation damage equals the raw strength after armor soak.
      it("reduces raw strength by equipped matching armor before the multiplier", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5 }),
        );

        character.takeDamage(5, StatType.Health);

        // raw = max(0, 5 - 2) = 3; final = 3 * 1 = 3; health 10 - 3 = 7
        expect(character.stats[StatType.Health]).toBeCloseTo(7);
      });

      it("does not mitigate when the armor defends a different stat", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Energy, modifier: 4, maxDurability: 5 }),
        );

        character.takeDamage(5, StatType.Health);

        expect(character.stats[StatType.Health]).toBeCloseTo(5);
      });

      it("does not mitigate with broken armor", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5, durability: 0 }),
        );

        character.takeDamage(5, StatType.Health);

        expect(character.stats[StatType.Health]).toBeCloseTo(5);
      });

      it("sums multiple matching armor pieces", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5 }),
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 1, maxDurability: 5 }),
        );

        character.takeDamage(5, StatType.Health);

        // raw = max(0, 5 - 3) = 2; final 2; health 10 - 2 = 8
        expect(character.stats[StatType.Health]).toBeCloseTo(8);
      });

      it("wears equipped matching armor by one when it absorbs a hit", () => {
        const armor = makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5 });
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(armor);

        character.takeDamage(5, StatType.Health);

        expect(armor.durability).toBe(4);
      });

      it("mitigates with non-durable armor but never wears it", () => {
        const armor = makeDurable({ type: "armor", stat: StatType.Health, modifier: 2 });
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(armor);

        expect(() => character.takeDamage(5, StatType.Health)).not.toThrow();

        // raw = max(0, 5 - 2) = 3; final 3; health 10 - 3 = 7
        expect(character.stats[StatType.Health]).toBeCloseTo(7);
        expect(armor.durability).toBeUndefined();
      });

      it("does not mitigate with unequipped armor", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({
            type: "armor",
            stat: StatType.Health,
            modifier: 2,
            maxDurability: 5,
            equipped: false,
          }),
        );

        character.takeDamage(5, StatType.Health);

        expect(character.stats[StatType.Health]).toBeCloseTo(5);
      });
    });
  });

  describe("status thresholds read the effective stat (lazy)", () => {
    function ringFor(stat: StatType, modifier: number): Item {
      return makeGear({ type: "accessory", slot: "finger", stat, modifier });
    }

    it("a +Health ring staves off KO when base health hits 0", () => {
      // Sanity 0 => health multiplier (10-0)*0.2 = 2; 2 damage * 2 = 4 vs 2 health => base floored to 0.
      const hero = makeCharacter({ stats: { [StatType.Health]: 2, [StatType.Sanity]: 0 } });
      const ring = ringFor(StatType.Health, 3);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(2);

      expect(hero.stats[StatType.Health]).toBe(0);     // base floored
      expect(hero.status).not.toContain(Status.KO);    // effective health = 0 + 3 > 0
    });

    it("removing the life-saving ring re-KOs at the next resolution trigger (lazy)", () => {
      // Sanity 1 keeps multiplier < 2 (1.8) so 2 damage still depletes base health;
      // but sanity > 0 means Fear (not Panic), which allows non-move actions like unequip.
      const hero = makeCharacter({ stats: { [StatType.Health]: 2, [StatType.Sanity]: 1 }, rng: () => 0.999 });
      const ring = ringFor(StatType.Health, 3);
      hero.inventory.items.push(ring);
      hero.equip(ring);
      hero.takeDamage(2);
      expect(hero.status).not.toContain(Status.KO);

      hero.unequip(ring);                               // pure slot op — status not yet refreshed
      hero.startTurn();                                 // next resolution trigger
      expect(hero.status).toContain(Status.KO);         // effective health now 0
    });

    it("a +Sanity ring above the Fear threshold prevents Fear", () => {
      // Base sanity 4 (< 5) would be Fear; +2 ring => effective 6 => no Fear.
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 4 } });
      const ring = ringFor(StatType.Sanity, 2);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.startTurn();                                 // resolution trigger

      expect(hero.status).not.toContain(Status.Fear);
    });

    it("still floors the base stat at 0 regardless of rings", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 1, [StatType.Energy]: 0 } });
      // Energy 0 => sanity multiplier 2; 5 * 2 = 10 vs sanity 1 => base floored to 0.
      hero.takeDamage(5, StatType.Sanity);
      expect(hero.stats[StatType.Sanity]).toBe(0);
    });
  });

  describe("move", () => {
    it("enters the target room and tracks it as the current room", () => {
      const character = makeCharacter();
      const room = makeRoom();

      character.move(room);

      expect(character.currentRoom).toBe(room);
      expect(room.enterRoom).toHaveBeenCalledWith(character);
    });

    it("exits the previous room before entering the next", () => {
      const character = makeCharacter();
      const first = makeRoom();
      const second = makeRoom();

      character.move(first);
      character.move(second);

      expect(first.exitRoom).toHaveBeenCalledWith(character);
      expect(second.enterRoom).toHaveBeenCalledWith(character);
      expect(character.currentRoom).toBe(second);
    });

    it("does not attempt to exit a room when there is none", () => {
      const character = makeCharacter();
      const room = makeRoom();

      character.move(room);

      expect(room.exitRoom).not.toHaveBeenCalled();
    });
  });

  describe("turn lifecycle", () => {
    it("startTurn fires the start event", () => {
      const character = makeCharacter();
      const onTurnStart = vi.spyOn(character.events, "onTurnStart");

      character.startTurn();

      expect(onTurnStart).toHaveBeenCalledOnce();
    });

    it("endTurn fires the end event", () => {
      const character = makeCharacter();
      const onTurnEnd = vi.spyOn(character.events, "onTurnEnd");

      character.endTurn();

      expect(onTurnEnd).toHaveBeenCalledOnce();
    });

    it("startTurn resets the action count so a fresh round can act again", () => {
      const character = makeCharacter({ actionsPerRound: 2, inventorySlots: 99 });
      const onTurnEnd = vi.spyOn(character.events, "onTurnEnd");

      // Two actions fill the round and end the turn.
      character.addToInventory(makeItem());
      character.addToInventory(makeItem());
      expect(onTurnEnd).toHaveBeenCalledTimes(1);

      // A new turn resets the counter, so two more actions are needed to end it.
      character.startTurn();
      character.addToInventory(makeItem());
      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      character.addToInventory(makeItem());
      expect(onTurnEnd).toHaveBeenCalledTimes(2);
    });
  });

  describe("recordAction", () => {
    it("ends the turn once the per-round action budget is spent", () => {
      const character = makeCharacter({ actionsPerRound: 3, inventorySlots: 99 });
      const onTurnEnd = vi.spyOn(character.events, "onTurnEnd");

      character.addToInventory(makeItem());
      character.addToInventory(makeItem());
      expect(onTurnEnd).not.toHaveBeenCalled();

      character.addToInventory(makeItem());
      expect(onTurnEnd).toHaveBeenCalledOnce();
    });

    it("ignores functions that are not registered as actions", () => {
      const character = makeCharacter({ actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(character.events, "onTurnEnd");

      character.recordAction(function notAnAction() {}, {
        kind: "takeDamage",
        amount: 0,
        stat: StatType.Health,
      });
      character.recordAction(() => {}, {
        kind: "takeDamage",
        amount: 0,
        stat: StatType.Health,
      });

      expect(onTurnEnd).not.toHaveBeenCalled();
    });
  });

  describe("IItemHolder conformance", () => {
    it("identifies itself as a character holder", () => {
      expect(makeCharacter().holderKind).toBe("character");
    });

    it("reports room while under capacity and none when full", () => {
      const character = makeCharacter({ inventorySlots: 1 });
      expect(character.hasRoomForItem()).toBe(true);

      character.receiveItem(makeItem());
      expect(character.hasRoomForItem()).toBe(false);
    });

    it("receiveItem adds the item and records itself as the holder", () => {
      const character = makeCharacter();
      const item = makeItem();

      character.receiveItem(item);

      expect(character.inventory.items).toContain(item);
      expect(
        (item as unknown as Record<symbol, unknown>)[Symbol.for("heldBy")],
      ).toBe(character);
    });

    it("relinquishItem removes the item from the inventory", () => {
      const character = makeCharacter();
      const item = makeItem();
      character.receiveItem(item);

      character.relinquishItem(item);

      expect(character.inventory.items).not.toContain(item);
    });

    it("relinquishItem is a no-op when the item is not held", () => {
      const character = makeCharacter();
      const kept = makeItem();
      character.receiveItem(kept);

      character.relinquishItem(makeItem()); // a different item, never added

      expect(character.inventory.items).toEqual([kept]);
    });
  });

  describe("keys (storage)", () => {
    it("defaults to an empty keyring", () => {
      expect(makeCharacter().inventory.keys).toEqual([]);
    });

    it("routes a received key into the keyring, not the item slots", () => {
      const character = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });

      character.receiveItem(key);

      expect(character.inventory.keys).toContain(key);
      expect(character.inventory.items).not.toContain(key);
    });

    it("relinquishes a key from the keyring", () => {
      const character = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });
      character.receiveItem(key);

      character.relinquishItem(key);

      expect(character.inventory.keys).not.toContain(key);
    });
  });

  describe("keys (free storage via addToInventory)", () => {
    it("adds a key even when the item slots are full", () => {
      const character = makeCharacter({ inventorySlots: 1 });
      character.addToInventory(makeItem()); // fills the only item slot
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });

      expect(() => character.addToInventory(key)).not.toThrow();
      expect(character.inventory.keys).toContain(key);
      expect(character.inventory.items).toHaveLength(1);
    });

    it("still throws when a non-key overflows the item slots", () => {
      const character = makeCharacter({ inventorySlots: 1 });
      character.addToInventory(makeItem());

      expect(() => character.addToInventory(makeItem())).toThrow(
        ProceduralViolation,
      );
    });
  });

  describe("keys (no dropping)", () => {
    it("refuses to drop a key", () => {
      const character = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });
      character.addToInventory(key);

      expect(() => character.removeFromInventory(key)).toThrow(
        ProceduralViolation,
      );
      expect(() => character.removeFromInventory(key)).toThrow(
        "Keys cannot be dropped; hand them over with transferKey instead.",
      );
      expect(character.inventory.keys).toContain(key);
    });
  });

  describe("transferKey", () => {
    it("moves a key from one character's keyring to another's", () => {
      const giver = makeCharacter();
      const recipient = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });
      giver.addToInventory(key);

      giver.transferKey(key, recipient);

      expect(giver.inventory.keys).not.toContain(key);
      expect(recipient.inventory.keys).toContain(key);
    });

    it("records a single pickUp on the recipient", () => {
      const giver = makeCharacter();
      const recipient = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });
      giver.addToInventory(key);

      giver.transferKey(key, recipient);

      expect(recipient.history.filter((e) => e.kind === "pickUp")).toHaveLength(1);
    });

    it("throws when the giver is not holding the key", () => {
      const giver = makeCharacter();
      const recipient = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });

      expect(() => giver.transferKey(key, recipient)).toThrow(ProceduralViolation);
    });

    it("rejects the generic Item.actions.transfer path for a key", () => {
      const giver = makeCharacter();
      const recipient = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: false });
      giver.addToInventory(key);

      // Keys are transfer-only via Character.transferKey; the generic item
      // transfer path must fail (it routes through removeFromInventory).
      expect(() => key.actions.transfer(giver, recipient)).toThrow(
        ProceduralViolation,
      );
      expect(giver.inventory.keys).toContain(key);
    });
  });

  describe("consumeKey", () => {
    it("removes the key from the keyring and clears its holder", () => {
      const character = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: true });
      character.addToInventory(key);

      character.consumeKey(key);

      expect(character.inventory.keys).not.toContain(key);
      expect(
        (key as unknown as Record<symbol, unknown>)[Symbol.for("heldBy")],
      ).toBeNull();
    });

    it("throws when the character is not holding the key", () => {
      const character = makeCharacter();
      const key = createKey({ name: "Key", keyCode: "vault", consumeOnUse: true });

      expect(() => character.consumeKey(key)).toThrow(ProceduralViolation);
    });
  });

  describe("addToInventory codex (items & keys)", () => {
    function makeSword(): Item {
      return new Item({
      descriptor: { name: "Sword", type: "weapon", recipe: { metal: 1 }, modifier: 3, stat: StatType.Health, slot: SlotKind.Hand },
      properties: { equippable: true, equipped: false, destroyable: false, usable: false },
      actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
      events: { onPickUp: () => {} },
    });
    }

    it("records a picked-up item, attributed to the party member", () => {
      const campaign = new Campaign({ title: "Codex" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();

      pc.addToInventory(makeSword());

      const entry = campaign.codex.items[0]!;
      expect(entry.snapshot.name).toBe("Sword");
      expect(entry.snapshot.type).toBe("weapon");
      expect(entry.snapshot.slot).toBe(SlotKind.Hand);
      expect(entry.firstSeen.characterId).toBe(pc.id);
    });

    it("records a picked-up key under the key kind, not the item kind", () => {
      const campaign = new Campaign({ title: "Codex" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      const key = createKey({ name: "Vault Key", keyCode: "vault", consumeOnUse: true });

      pc.addToInventory(key);

      expect(campaign.codex.items).toHaveLength(0);
      const entry = campaign.codex.keys[0]!;
      expect(entry.snapshot).toEqual({ name: "Vault Key", keyCode: "vault", consumeOnUse: true });
    });

    it("records a recipe taught by a picked-up item, attributed to the picker", () => {
      const campaign = new Campaign({ title: "Codex" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      const recipe = { id: "potion", materials: { healing: 1 }, create: () => makeSword() } as unknown as Parameters<typeof campaign.discoverRecipe>[0];
      const scroll = new Item({
      descriptor: { name: "Scroll", type: "consumable", recipe: { metal: 1 }, modifier: 0, stat: StatType.Health, teaches: recipe },
      properties: { equippable: false, equipped: false, destroyable: false, usable: false },
      actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
      events: { onPickUp: () => {} },
    });

      pc.addToInventory(scroll);

      const entry = campaign.codex.recipes[0]!;
      expect(entry.snapshot.id).toBe("potion");
      expect(entry.firstSeen.characterId).toBe(pc.id);
    });
  });

  describe("harvest", () => {
    function setup() {
      const campaign = new Campaign({ title: "Materials" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const cache = new MaterialCache({ contents: { metal: 3, glass: 1 } });
      const room = new Room({ name: "Vault", description: "a vault", loot: [], materials: [cache] });
      character.move(room);
      return { campaign, character, cache };
    }

    it("records harvested material kinds in the codex, attributed to a party member", () => {
      const campaign = new Campaign({ title: "Materials" });
      const pc = new PlayerCharacter({ campaign, name: "Hero" });
      pc.joinCampaign();
      const cache = new MaterialCache({ contents: { metal: 3, glass: 1 } });
      const room = new Room({ name: "Vault", description: "a vault", loot: [], materials: [cache] });
      pc.move(room);

      pc.harvest(cache);

      expect(campaign.codex.materials.map((m) => m.snapshot.type).sort()).toEqual(["glass", "metal"]);
      expect(campaign.codex.materials.every((m) => m.firstSeen.characterId === pc.id)).toBe(true);
    });

    it("deposits a co-located cache into the party pool and depletes it", () => {
      const { campaign, character, cache } = setup();

      character.harvest(cache);

      expect(campaign.materials).toEqual({ metal: 3, glass: 1 });
      expect(cache.depleted).toBe(true);
    });

    it("is idempotent: a second harvest deposits nothing more", () => {
      const { campaign, character, cache } = setup();

      character.harvest(cache);
      character.harvest(cache);

      expect(campaign.materials).toEqual({ metal: 3, glass: 1 });
    });

    it("throws when the cache is not in the current room", () => {
      const { character } = setup();
      const stray = new MaterialCache({ contents: { metal: 9 } });

      expect(() => character.harvest(stray)).toThrow(ProceduralViolation);
    });

    it("throws when the character is in no room", () => {
      const character = new Character({ campaign: new Campaign({ title: "Materials" }), name: "Hero", stats: makeStats() });
      const cache = new MaterialCache({ contents: { metal: 1 } });

      // move() was never called, so currentRoom is null.
      expect(() => character.harvest(cache)).toThrow(ProceduralViolation);
    });

    it("does not consume an action (records no history)", () => {
      const { character, cache } = setup();
      const before = character.history.length;

      character.harvest(cache);

      expect(character.history.length).toBe(before);
    });

    it("throws in an unlit room when the harvester cannot see in the dark", () => {
      const campaign = new Campaign({ title: "Materials" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const cache = new MaterialCache({ contents: { metal: 3 } });
      // Authored-dark room holding the cache; co-locate via the [PLACE] seam.
      const room = new Room({ name: "Cellar", description: "dark cellar", loot: [], materials: [cache], dark: true });
      character[PLACE](room);

      expect(room.isLit).toBe(false);
      expect(character.seesInDark).toBe(false);
      expect(() => character.harvest(cache)).toThrow(ProceduralViolation);
    });

    it("does not throw once the dark room is lit", () => {
      const campaign = new Campaign({ title: "Materials" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const cache = new MaterialCache({ contents: { metal: 3 } });
      const room = new Room({ name: "Cellar", description: "dark cellar", loot: [], materials: [cache], dark: true });
      character[PLACE](room);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      character.addToInventory(torch);
      character.placeLight(torch);

      expect(room.isLit).toBe(true);
      expect(() => character.harvest(cache)).not.toThrow();
      expect(campaign.materials).toEqual({ metal: 3 });
    });
  });

  describe("repair", () => {
    it("restores a damaged held item to full for a proportional, debited cost", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 3 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 5 });

      character.repair(weapon);

      // missing 7 of 10 -> ceil(4 * 7 / 10) = ceil(2.8) = 3 metal; 5 - 3 = 2 left
      expect(weapon.durability).toBe(10);
      expect(campaign.materials).toEqual({ metal: 2 });
    });

    it("charges the full recipe to fully restore a broken item", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 0 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 4 });

      character.repair(weapon);

      // missing 10 of 10 -> ceil(4 * 10 / 10) = 4 metal (whole recipe); pool emptied
      expect(weapon.durability).toBe(10);
      expect(campaign.materials).toEqual({});
    });

    it("throws and spends nothing for an item the character is not holding", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 3 });
      campaign.claimMaterials("seed", { metal: 5 });

      expect(() => character.repair(weapon)).toThrow(ProceduralViolation);
      expect(campaign.materials).toEqual({ metal: 5 });
    });

    it("throws for an item that has no durability", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const plain = makeDurable({ recipe: { metal: 1 } }); // no maxDurability
      character.inventory.items.push(plain);

      expect(() => character.repair(plain)).toThrow(ProceduralViolation);
    });

    it("throws for an item that is not damaged", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10 }); // full
      character.inventory.items.push(weapon);

      expect(() => character.repair(weapon)).toThrow(ProceduralViolation);
    });

    it("throws and spends nothing when the pool cannot afford the cost", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 0 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 1 }); // need 4

      expect(() => character.repair(weapon)).toThrow(ProceduralViolation);
      expect(campaign.materials).toEqual({ metal: 1 });
      expect(weapon.durability).toBe(0);
    });

    it("does not consume an action (records no history)", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 3 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 5 });

      const before = character.history.length;
      character.repair(weapon);

      expect(character.history.length).toBe(before);
    });

    it("debits each recipe component proportionally", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const weapon = makeDurable({
        recipe: { metal: 4, electronics: 2 },
        maxDurability: 10,
        durability: 5,
      });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 3, electronics: 2 });

      character.repair(weapon);

      // missing 5 of 10 -> metal ceil(4*5/10)=2, electronics ceil(2*5/10)=1
      expect(weapon.durability).toBe(10);
      expect(campaign.materials).toEqual({ metal: 1, electronics: 1 });
    });

    it("throws when asked to repair a key", () => {
      const campaign = new Campaign({ title: "Repair" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const key = createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
      character.addToInventory(key);

      expect(() => character.repair(key)).toThrow("Keys cannot be repaired.");
    });
  });

  describe("recipe discovery on pickup", () => {
    it("teaches the party a recipe when a teaching item is picked up", () => {
      const recipe: CraftingRecipe = {
        id: "torch" as RecipeId,
        materials: { metal: 1 },
        create: () => ({ name: "Torch" }) as unknown as IItem,
      };
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });

      character.addToInventory(makeTeachingItem(recipe));

      expect(campaign.knows("torch" as RecipeId)).toBe(true);
    });

    it("discovers nothing for an item that teaches no recipe", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });

      character.addToInventory(makeItem());

      expect(campaign.knownRecipes.size).toBe(0);
    });
  });

  describe("craft (item track)", () => {
    it("withdraws materials and places the crafted item in inventory", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const output = makeItem();
      const recipeId = "widget" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        materials: { metal: 2 },
        create: () => output,
      };
      campaign.claimMaterials("seed", { metal: 2 });
      campaign.discoverRecipe(recipe);

      const result = character.craft(recipeId);

      expect(result).toBe(output);
      expect(character.inventory.items).toContain(output);
      expect(campaign.canAfford({ metal: 1 })).toBe(false);
    });

    it("throws ProceduralViolation on an undiscovered recipe", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });

      expect(() => character.craft("unknown-recipe" as RecipeId)).toThrow(
        new ProceduralViolation("Cannot craft an undiscovered recipe"),
      );
    });

    it("throws and spends nothing when materials are insufficient", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const recipeId = "expensive-widget" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        materials: { metal: 5 },
        create: () => makeItem(),
      };
      // Seed only 2 metal, but recipe costs 5
      campaign.claimMaterials("seed", { metal: 2 });
      campaign.discoverRecipe(recipe);

      expect(() => character.craft(recipeId)).toThrow(ProceduralViolation);
      // Pool unchanged: still has 2 metal
      expect(campaign.canAfford({ metal: 2 })).toBe(true);
    });

    it("throws and spends nothing when there is no inventory slot", () => {
      const campaign = new Campaign({ title: "Crafting" });
      // 0 inventory slots
      const character = new Character({ campaign, name: "Hero", stats: makeStats(), inventorySlots: 0 });
      const recipeId = "widget" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        materials: { metal: 1 },
        create: () => makeItem(),
      };
      campaign.claimMaterials("seed", { metal: 1 });
      campaign.discoverRecipe(recipe);

      expect(() => character.craft(recipeId)).toThrow(ProceduralViolation);
      // Materials should be untouched
      expect(campaign.canAfford({ metal: 1 })).toBe(true);
    });

    it("does not consume an action (records no history)", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const recipeId = "widget" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        materials: { metal: 1 },
        create: () => makeItem(),
      };
      campaign.claimMaterials("seed", { metal: 1 });
      campaign.discoverRecipe(recipe);

      const before = character.history.length;
      character.craft(recipeId);

      expect(character.history.length).toBe(before);
    });
  });

  describe("craft (key track)", () => {
    it("consumes required keys and places the crafted key in the keyring", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const bronze1 = createKey({ name: "Bronze Key", keyCode: "bronze", consumeOnUse: false });
      const bronze2 = createKey({ name: "Bronze Key", keyCode: "bronze", consumeOnUse: false });
      character.addToInventory(bronze1);
      character.addToInventory(bronze2);

      const recipeId = "silver-key" as RecipeId;
      const silverKey = createKey({ name: "Silver Key", keyCode: "silver", consumeOnUse: false });
      const recipe: CraftingRecipe = {
        id: recipeId,
        keys: [{ keyCode: "bronze", qty: 2 }],
        create: () => silverKey,
      };
      campaign.discoverRecipe(recipe);

      const result = character.craft(recipeId);

      expect(result).toBe(silverKey);
      expect(character.inventory.keys).toContain(silverKey);
      const bronzeCount = character.inventory.keys.filter(
        (k) => k.keyCode === "bronze",
      ).length;
      expect(bronzeCount).toBe(0);
    });

    it("throws and consumes nothing when a required key is missing", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      const bronze1 = createKey({ name: "Bronze Key", keyCode: "bronze", consumeOnUse: false });
      character.addToInventory(bronze1);

      const recipeId = "silver-key-2" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        keys: [{ keyCode: "bronze", qty: 2 }],
        create: () => createKey({ name: "Silver Key", keyCode: "silver", consumeOnUse: false }),
      };
      campaign.discoverRecipe(recipe);

      expect(() => character.craft(recipeId)).toThrow(ProceduralViolation);
      const bronzeCount = character.inventory.keys.filter(
        (k) => k.keyCode === "bronze",
      ).length;
      expect(bronzeCount).toBe(1);
    });

    it("combines duplicate key codes into a single total cost", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      character.addToInventory(
        createKey({ name: "Bronze Key", keyCode: "bronze", consumeOnUse: false }),
      );

      // Two entries for the same code demand two keys in total, not one each.
      const recipeId = "silver-key-3" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        keys: [
          { keyCode: "bronze", qty: 1 },
          { keyCode: "bronze", qty: 1 },
        ],
        create: () => createKey({ name: "Silver Key", keyCode: "silver", consumeOnUse: false }),
      };
      campaign.discoverRecipe(recipe);

      // Only one bronze held, so it falls short and consumes nothing.
      expect(() => character.craft(recipeId)).toThrow(ProceduralViolation);
      const bronzeCount = character.inventory.keys.filter(
        (k) => k.keyCode === "bronze",
      ).length;
      expect(bronzeCount).toBe(1);
    });

    it("does not consume an action (records no history)", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats() });
      character.addToInventory(
        createKey({ name: "Bronze Key", keyCode: "bronze", consumeOnUse: false }),
      );

      const recipeId = "silver-key-4" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        keys: [{ keyCode: "bronze", qty: 1 }],
        create: () => createKey({ name: "Silver Key", keyCode: "silver", consumeOnUse: false }),
      };
      campaign.discoverRecipe(recipe);

      const before = character.history.length;
      character.craft(recipeId);

      expect(character.history.length).toBe(before);
    });
  });

  describe("party-wide crafting (seam)", () => {
    it("lets one member craft a recipe a different member discovered", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const finder = new Character({ campaign, name: "Finder", stats: makeStats() });
      const crafter = new Character({ campaign, name: "Crafter", stats: makeStats() });

      const output = makeItem();
      const recipeId = "shared-widget" as RecipeId;
      const recipe: CraftingRecipe = {
        id: recipeId,
        materials: { metal: 1 },
        create: () => output,
      };

      // The finder picks up a blueprint, teaching the whole party the recipe.
      finder.addToInventory(makeTeachingItem(recipe, "blueprint"));
      expect(campaign.knows(recipeId)).toBe(true);

      // A different party member can now craft it from the shared pool.
      campaign.claimMaterials("seed", { metal: 1 });
      const result = crafter.craft(recipeId);

      expect(result).toBe(output);
      expect(crafter.inventory.items).toContain(output);
    });
  });

  describe("action history", () => {
    it("records a move with the destination room id and name", () => {
      const character = makeCharacter();
      const room = makeRoom();
      character.move(room);
      expect(character.history).toHaveLength(1);
      expect(character.history[0]).toMatchObject({
        kind: "move",
        room: { id: room.id, name: room.name },
      });
    });

    it("records pickUp when adding to inventory and drop when removing", () => {
      const character = makeCharacter({ inventorySlots: 5 });
      const item = makeItem();
      character.addToInventory(item);
      character.removeFromInventory(item);
      expect(character.history.map((e) => e.kind)).toEqual(["pickUp", "drop"]);
      expect(character.history[0]).toMatchObject({
        kind: "pickUp",
        items: [{ id: item.id, name: item.name }],
      });
    });

    it("records takeDamage with the mitigated amount and stat", () => {
      // Sanity 5 mitigates Health: multiplier = (10 - 5) * 0.2 = 1, so 5 damage applies as 5.
      const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
      character.takeDamage(5, StatType.Health);
      expect(character.history.at(-1)).toMatchObject({
        kind: "takeDamage",
        amount: 5,
        stat: StatType.Health,
      });
    });

    it("stamps each entry with the current campaign round", () => {
      const character = new Character({ campaign: { round: 7, [EMIT_CUE]: () => {} } as unknown as ICampaign, name: "Hero", stats: makeStats() });
      character.move(makeRoom());
      expect(character.history[0]?.round).toBe(7);
    });

    it("returns a read-only snapshot that cannot mutate internal state", () => {
      const character = makeCharacter();
      const room = makeRoom();
      character.move(room);
      const snapshot = character.history as ActionHistoryEntry[];
      snapshot.push({
        kind: "move",
        round: 99,
        room: { id: room.id, name: room.name },
      });
      expect(character.history).toHaveLength(1);
    });
  });

  describe("takeDamage with accessory mitigation", () => {
    function ringFor(stat: StatType, modifier: number): Item {
      return makeGear({ type: "accessory", slot: "finger", stat, modifier });
    }

    it("a ring on the mitigator stat reduces incoming damage", () => {
      // Health is mitigated by Sanity. Base sanity 5 => multiplier (10-5)*0.2 = 1.0 => 5*1.0 = 5 damage.
      // A +3 Sanity ring => effective 8 => multiplier (10-8)*0.2 = 0.4 => 5*0.4 = 2 damage.
      const hero = makeCharacter({ stats: { [StatType.Health]: 10, [StatType.Sanity]: 5 } });
      const ring = ringFor(StatType.Sanity, 3);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(5);

      expect(hero.stats[StatType.Health]).toBeCloseTo(8); // 10 - 2
    });

    it("an over-cap mitigator floors the multiplier at 0 — full absorption, never healing", () => {
      // Base sanity 9 + ring 5 => effective 14 => (10-14) clamped to 0 => 0 damage.
      const hero = makeCharacter({ stats: { [StatType.Health]: 6, [StatType.Sanity]: 9 } });
      const ring = ringFor(StatType.Sanity, 5);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(10);

      expect(hero.stats[StatType.Health]).toBeCloseTo(6); // unchanged, NOT increased
    });
  });

  describe("effectiveStat", () => {
    function makeRing(stat: StatType, modifier: number, name = "Ring"): Item {
      return makeGear({ type: "accessory", slot: "finger", stat, modifier, name });
    }
    function heroWearing(rings: Item[], stats?: Partial<Stats>) {
      const hero = makeCharacter({ stats });
      for (const ring of rings) {
        hero.inventory.items.push(ring);
        hero.equip(ring);
      }
      return hero;
    }

    it("returns the base stat when no accessories are worn", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 7 } });
      expect(hero.effectiveStat(StatType.Sanity)).toBe(7);
    });

    it("adds an equipped accessory's modifier for the matching stat", () => {
      const hero = heroWearing([makeRing(StatType.Sanity, 2)], { [StatType.Sanity]: 6 });
      expect(hero.effectiveStat(StatType.Sanity)).toBe(8);
    });

    it("sums multiple matching rings additively", () => {
      const hero = heroWearing(
        [makeRing(StatType.Sanity, 2, "A"), makeRing(StatType.Sanity, 3, "B")],
        { [StatType.Sanity]: 5 },
      );
      expect(hero.effectiveStat(StatType.Sanity)).toBe(10);
    });

    it("ignores accessories targeting a different stat", () => {
      const hero = heroWearing([makeRing(StatType.Health, 4)], { [StatType.Sanity]: 6 });
      expect(hero.effectiveStat(StatType.Sanity)).toBe(6);
    });

    it("ignores accessories that are in inventory but not equipped", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 6 } });
      const ring = makeRing(StatType.Sanity, 2);
      hero.inventory.items.push(ring); // present but never equipped
      expect(hero.effectiveStat(StatType.Sanity)).toBe(6);
    });

    it("does not count non-accessory items with the same stat (no double-count)", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 6 } });
      const weapon = makeGear({ type: "weapon", slot: "hand", stat: StatType.Sanity, modifier: 5 });
      hero.inventory.items.push(weapon);
      hero.equip(weapon);
      expect(hero.effectiveStat(StatType.Sanity)).toBe(6);
    });

    it("never mutates the base stat", () => {
      const hero = heroWearing([makeRing(StatType.Sanity, 2)], { [StatType.Sanity]: 6 });
      hero.effectiveStat(StatType.Sanity);
      expect(hero.stats[StatType.Sanity]).toBe(6);
    });
  });

  describe("passive ring effects seam", () => {
    it("worn rings drive both mitigation and status off the effective value", () => {
      // Base sanity 4 would mean Fear and weak mitigation; a +2 Sanity ring => effective 6.
      const hero = makeCharacter({ stats: { [StatType.Health]: 10, [StatType.Sanity]: 4 } });
      const ring = makeGear({ type: "accessory", slot: "finger", stat: StatType.Sanity, modifier: 2 });
      hero.inventory.items.push(ring);
      hero.equip(ring);

      // Mitigation: Health mitigated by effective Sanity 6 => (10-6)*0.2 = 0.8 => 5 * 0.8 = 4.
      hero.takeDamage(5);

      expect(hero.stats[StatType.Health]).toBeCloseTo(6);  // 10 - 4
      expect(hero.status).not.toContain(Status.Fear);      // effective sanity 6 >= 5
    });

    it("the four-finger cap bounds the passive bonus — a fifth ring auto-swaps", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 2 } });
      const rings = [0, 1, 2, 3, 4].map((n) =>
        makeGear({ type: "accessory", slot: "finger", stat: StatType.Sanity, modifier: 2, name: `R${n}` }),
      );
      rings.forEach((ring) => {
        hero.inventory.items.push(ring);
        hero.equip(ring);
      });

      expect(rings.filter((r) => r.properties.equipped)).toHaveLength(4); // only four finger slots
      // The bound holds at the effective layer: exactly four rings' worth of bonus,
      // never a fifth. (Which ring is displaced is asserted by the equip unit tests.)
      expect(hero.effectiveStat(StatType.Sanity)).toBe(10);   // 2 + 4*2
      expect(hero.effectiveStat(StatType.Sanity)).not.toBe(12); // never 2 + 5*2
    });

    it("is lossless — equip, take damage, unequip leaves base reflecting only real damage", () => {
      const hero = makeCharacter({ stats: { [StatType.Health]: 10, [StatType.Sanity]: 5 } });
      // A Health ring does not affect Health's mitigator (Sanity), so it changes no damage here.
      const ring = makeGear({ type: "accessory", slot: "finger", stat: StatType.Health, modifier: 4 });
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(5); // sanity 5 => multiplier 1 => 5 damage => base health 5
      expect(hero.stats[StatType.Health]).toBeCloseTo(5);
      expect(hero.effectiveStat(StatType.Health)).toBeCloseTo(9); // 5 + 4 while worn

      hero.unequip(ring);
      expect(hero.stats[StatType.Health]).toBeCloseTo(5);          // base never carried the bonus
      expect(hero.effectiveStat(StatType.Health)).toBeCloseTo(5);  // bonus gone with the ring
    });
  });

  describe("equip", () => {
    function heroWith(...items: Item[]) {
      const character = new Character({ campaign: new Campaign({ title: "Equip" }), name: "Hero", stats: makeStats() });
      for (const item of items) character.inventory.items.push(item);
      return character;
    }

    it("equips an item into a free named slot of its kind", () => {
      const helm = makeGear({ type: "armor", slot: "head", name: "Helm" });
      const hero = heroWith(helm);

      hero.equip(helm);

      expect(helm.properties.equipped).toBe(true);
      expect(hero.equipment.get(EquipmentSlot.Head)).toBe(helm);
    });

    it("auto-assigns rings to the first free finger, then the next", () => {
      const r1 = makeGear({ type: "accessory", slot: "finger", name: "R1" });
      const r2 = makeGear({ type: "accessory", slot: "finger", name: "R2" });
      const hero = heroWith(r1, r2);

      hero.equip(r1);
      hero.equip(r2);

      expect(hero.equipment.get(EquipmentSlot.LeftIndexFinger)).toBe(r1);
      expect(hero.equipment.get(EquipmentSlot.LeftRingFinger)).toBe(r2);
    });

    it("honors an explicit target slot", () => {
      const ring = makeGear({ type: "accessory", slot: "finger", name: "R" });
      const hero = heroWith(ring);

      hero.equip(ring, EquipmentSlot.RightRingFinger);

      expect(hero.equipment.get(EquipmentSlot.RightRingFinger)).toBe(ring);
    });

    it("auto-swaps the occupant of a single-capacity slot", () => {
      const helmA = makeGear({ type: "armor", slot: "head", name: "A" });
      const helmB = makeGear({ type: "armor", slot: "head", name: "B" });
      const hero = heroWith(helmA, helmB);
      hero.equip(helmA);

      hero.equip(helmB);

      expect(hero.equipment.get(EquipmentSlot.Head)).toBe(helmB);
      expect(helmA.properties.equipped).toBe(false);
      expect(hero.inventory.items).toContain(helmA); // displaced, still held
    });

    it("fills all four fingers, then auto-swaps the first", () => {
      const rings = [0, 1, 2, 3, 4].map((n) =>
        makeGear({ type: "accessory", slot: "finger", name: `R${n}` }),
      );
      const hero = heroWith(...rings);
      rings.forEach((r) => hero.equip(r));

      const equipped = rings.filter((r) => r.properties.equipped);
      expect(equipped).toHaveLength(4); // only four finger slots
      expect(rings[0]!.properties.equipped).toBe(false); // first displaced
    });

    it("a two-handed weapon occupies both hands and displaces them", () => {
      const sword = makeGear({ type: "weapon", slot: "hand", name: "1H-A" });
      const dagger = makeGear({ type: "weapon", slot: "hand", name: "1H-B" });
      const greatsword = makeGear({ type: "weapon", slot: "hand", twoHanded: true, name: "2H" });
      const hero = heroWith(sword, dagger, greatsword);
      hero.equip(sword);
      hero.equip(dagger); // both hands now full

      hero.equip(greatsword);

      expect(hero.equipment.get(EquipmentSlot.LeftHand)).toBe(greatsword);
      expect(hero.equipment.get(EquipmentSlot.RightHand)).toBe(greatsword);
      expect(sword.properties.equipped).toBe(false);
      expect(dagger.properties.equipped).toBe(false);
    });

    it("equipping a one-handed weapon displaces a worn two-handed weapon", () => {
      const greatsword = makeGear({ type: "weapon", slot: "hand", twoHanded: true, name: "2H" });
      const dagger = makeGear({ type: "weapon", slot: "hand", name: "1H" });
      const hero = heroWith(greatsword, dagger);
      hero.equip(greatsword);

      hero.equip(dagger, EquipmentSlot.LeftHand);

      expect(hero.equipment.get(EquipmentSlot.LeftHand)).toBe(dagger);
      expect(hero.equipment.has(EquipmentSlot.RightHand)).toBe(false);
      expect(greatsword.properties.equipped).toBe(false);
    });

    it("unequip clears the slot and leaves the item in inventory", () => {
      const helm = makeGear({ type: "armor", slot: "head", name: "Helm" });
      const hero = heroWith(helm);
      hero.equip(helm);

      hero.unequip(helm);

      expect(helm.properties.equipped).toBe(false);
      expect(hero.equipment.has(EquipmentSlot.Head)).toBe(false);
      expect(hero.inventory.items).toContain(helm);
    });

    it("unequipping a two-handed weapon frees both hand slots", () => {
      const greatsword = makeGear({ type: "weapon", slot: "hand", twoHanded: true, name: "2H" });
      const hero = heroWith(greatsword);
      hero.equip(greatsword);
      expect(hero.equipment.get(EquipmentSlot.LeftHand)).toBe(greatsword);
      expect(hero.equipment.get(EquipmentSlot.RightHand)).toBe(greatsword);

      hero.unequip(greatsword);

      expect(greatsword.properties.equipped).toBe(false);
      expect(hero.equipment.has(EquipmentSlot.LeftHand)).toBe(false);
      expect(hero.equipment.has(EquipmentSlot.RightHand)).toBe(false);
      expect(hero.inventory.items).toContain(greatsword);
    });

    it("throws for an unheld / non-equippable / slot-less item and a bad target", () => {
      const hero = heroWith();
      const unheld = makeGear({ type: "armor", slot: "head" });
      expect(() => hero.equip(unheld)).toThrow(ProceduralViolation);

      const notEquippable = makeGear({ type: "armor", slot: "head", equippable: false });
      hero.inventory.items.push(notEquippable);
      expect(() => hero.equip(notEquippable)).toThrow(ProceduralViolation);

      const slotless = makeGear({ type: "consumable", slot: undefined });
      hero.inventory.items.push(slotless);
      expect(() => hero.equip(slotless)).toThrow(ProceduralViolation);

      const ring = makeGear({ type: "accessory", slot: "finger" });
      hero.inventory.items.push(ring);
      expect(() => hero.equip(ring, EquipmentSlot.Head)).toThrow(ProceduralViolation);
    });

    it("throws when unequipping an item that is not equipped", () => {
      const helm = makeGear({ type: "armor", slot: "head" });
      const hero = heroWith(helm);
      expect(() => hero.unequip(helm)).toThrow(ProceduralViolation);
    });

    it("records no history (free actions)", () => {
      const helm = makeGear({ type: "armor", slot: "head" });
      const hero = heroWith(helm);
      const before = hero.history.length;
      hero.equip(helm);
      hero.unequip(helm);
      expect(hero.history.length).toBe(before);
    });

    it("equipping via the item's own action still validates the slot (no bypass)", () => {
      const hero = new Character({ campaign: new Campaign({ title: "Equip" }), name: "Hero", stats: makeStats() });
      const helm = makeGear({ type: "armor", slot: "head", name: "Helm" });
      hero.addToInventory(helm); // claims the item to the hero (sets its holder)

      helm.actions.equip(hero); // public low-level entry → routes to hero.equip

      expect(hero.equipment.get(EquipmentSlot.Head)).toBe(helm);
      expect(helm.properties.equipped).toBe(true);
    });
  });

  describe("status consequences — gating", () => {
    it("KO blocks a recordable action", () => {
      const c = makeCharacter({ stats: { [StatType.Health]: 0 }, rng: () => 0.999 });
      c.takeDamage(0); // reconcile -> KO
      expect(() => c.addToInventory(makeItem())).toThrow(/KO/);
    });

    it("Panic blocks non-move actions but allows move", () => {
      const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      c.takeDamage(0, StatType.Sanity); // Panic
      expect(() => c.addToInventory(makeItem())).toThrow(/Panicked/);
      expect(() => c.move(makeRoom())).not.toThrow();
    });

    it("Fear blocks move but allows other actions", () => {
      const c = makeCharacter({ stats: { [StatType.Sanity]: 3 }, rng: () => 0.999 });
      c.takeDamage(0, StatType.Sanity); // Fear
      expect(() => c.move(makeRoom())).toThrow(/afraid/);
      expect(() => c.addToInventory(makeItem())).not.toThrow();
    });

    it("Confused fizzle records a fumble (rng 0 => roll 1 <= 50)", () => {
      const c = makeCharacter({ stats: { [StatType.Energy]: 0 }, rng: () => 0 });
      c.takeDamage(0, StatType.Energy); // Confused
      c.addToInventory(makeItem());      // attempt -> fizzles, records a fumble
      expect(c.history.at(-1)?.kind).toBe("fumble");
    });

    it("KO blocks use, but Panic does not", () => {
      const ko = makeCharacter({ stats: { [StatType.Health]: 0 }, rng: () => 0.999 });
      const tonicA = makeGear({ type: "consumable", equippable: false, usable: true, modifier: 0 });
      ko.addToInventory(tonicA); // added while still normal (no reconcile yet)
      ko.takeDamage(0);          // reconcile -> KO
      expect(() => tonicA.actions.use(ko)).toThrow(/KO/);

      const panicked = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      const tonicB = makeGear({ type: "consumable", equippable: false, usable: true, modifier: 0,
        grantsImmunity: { statuses: [Status.Panic], turns: 1 } });
      panicked.addToInventory(tonicB);
      panicked.takeDamage(0, StatType.Sanity); // Panic
      expect(() => tonicB.actions.use(panicked)).not.toThrow();
    });

    it("transferKey does not lose the key when the recipient is KO'd", () => {
      const giver = makeCharacter();
      const recipient = makeCharacter({ stats: { [StatType.Health]: 0 }, rng: () => 0.999 });
      const key = createKey({ name: "Vault", keyCode: "vault", consumeOnUse: false });
      giver.addToInventory(key);
      recipient.takeDamage(0); // reconcile -> KO

      expect(() => giver.transferKey(key, recipient)).toThrow(/KO/);
      expect(giver.inventory.keys.some((k) => k.id === key.id)).toBe(true);
    });

    it("Confused fizzle on craft returns null, records a fumble, spends no materials", () => {
      const campaign = new Campaign({ title: "Crafting" });
      const character = new Character({ campaign, name: "Hero", stats: makeStats({ [StatType.Energy]: 0 }), inventorySlots: undefined, actionsPerRound: undefined, rng: () => 0 });
      const recipeId = "widget" as RecipeId;
      const cost = { metal: 2 };
      const recipe: CraftingRecipe = {
        id: recipeId,
        materials: cost,
        create: () => makeItem(),
      };
      campaign.claimMaterials("seed", cost);
      campaign.discoverRecipe(recipe);

      character.takeDamage(0, StatType.Energy); // reconcile -> Confused (energy 0)

      const result = character.craft(recipeId);

      expect(result).toBeNull();
      expect(character.history.at(-1)?.kind).toBe("fumble");
      expect(campaign.canAfford(cost)).toBe(true);
    });

    it("transferKey keeps the key with the giver when the Confused recipient fizzles the pickup", () => {
      // rng: () => 0 means roll(100) returns 1, which is <= 50 (confusedFailChance),
      // so every gated action on the recipient fizzles.
      const giver = makeCharacter();
      const recipient = makeCharacter({ stats: { [StatType.Energy]: 0 }, rng: () => 0 });
      const key = createKey({ name: "Vault", keyCode: "vault", consumeOnUse: false });
      giver.addToInventory(key);
      recipient.takeDamage(0, StatType.Energy); // reconcile -> Confused
      expect(recipient.status).toContain(Status.Confused);

      // transferKey must not throw; the fizzled pickup means the key stays with the giver.
      expect(() => giver.transferKey(key, recipient)).not.toThrow();
      expect(giver.inventory.keys.some((k) => k.id === key.id)).toBe(true);
      expect(recipient.inventory.keys.some((k) => k.id === key.id)).toBe(false);
    });

    it("Confused character exhausts its action budget even when every action fizzles", () => {
      // actionsPerRound: 2, rng: () => 0 => every gated call fizzles.
      const c = makeCharacter({
        stats: { [StatType.Energy]: 0 },
        rng: () => 0,
        actionsPerRound: 2,
        inventorySlots: 99,
      });
      c.takeDamage(0, StatType.Energy); // reconcile -> Confused
      const onTurnEnd = vi.spyOn(c.events, "onTurnEnd");

      // Each fizzle records a fumble and ticks the budget for budgeted actions.
      c.addToInventory(makeItem()); // fizzle #1 — budget 1/2
      expect(onTurnEnd).not.toHaveBeenCalled();
      c.addToInventory(makeItem()); // fizzle #2 — budget 2/2 -> turn ends
      expect(onTurnEnd).toHaveBeenCalledOnce();
    });
  });

  describe("status consequences — wiring & immunity", () => {
    it("derives Panic from depleted sanity (unchanged surface)", () => {
      const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      c.takeDamage(0, StatType.Sanity); // forces a reconcile
      expect(c.status).toEqual([Status.Panic]);
    });

    it("passive immunity: an equipped ward (modifier 0) suppresses Panic", () => {
      const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      const ward = makeGear({
        type: "accessory", slot: SlotKind.Finger, stat: StatType.Sanity,
        modifier: 0, immunities: [Status.Panic],
      });
      c.addToInventory(ward);
      c.equip(ward);
      c.takeDamage(0, StatType.Sanity); // reconcile
      expect(c.isNormal).toBe(true);

      c.unequip(ward);
      c.takeDamage(0, StatType.Sanity); // reconcile -> reapplies
      expect(c.status).toEqual([Status.Panic]);
    });

    it("timed immunity: using a consumable grants N turns via the seam", () => {
      const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
      const tonic = makeGear({
        type: "consumable", equippable: false, usable: true, modifier: 0,
        stat: StatType.Sanity, grantsImmunity: { statuses: [Status.Panic], turns: 2 },
      });
      c.addToInventory(tonic);
      tonic.actions.use(c);   // applies immunity, then consumes
      c.endTurn();           // reconcile while immune
      expect(c.isNormal).toBe(true);
    });
  });

  describe("onKnockOut hook", () => {
    class HookSpy extends Character {
      knockOuts = 0;
      protected override onKnockOut() {
        this.knockOuts += 1;
      }
    }

    function makeSpy(health: number) {
      return new HookSpy({ campaign: makeCampaign(), name: "Spy", stats: makeStats({ [StatType.Health]: health }) });
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

    it("does not fire via startTurn (startTurn bypasses #reconcile)", () => {
      const spy = makeSpy(0);
      spy.startTurn(); // goes through afflictions.onTurnStart, not #reconcile
      expect(spy.knockOuts).toBe(0);
    });
  });

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

  describe("action cues", () => {
    it("emits an action cue when an action is recorded, resolving the actor's sound", () => {
      const campaign = new Campaign({ title: "Cues" });
      const character = new Character({ campaign, name: "Mira", stats: makeStats(), inventorySlots: 5, actionsPerRound: 3, presentation: { sound: "mira.ogg" } });
      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      character.move({ id: "r1", name: "Hall", enterRoom: () => {}, exitRoom: () => {} } as unknown as IRoom);

      expect(seen).toContainEqual(
        expect.objectContaining({ kind: "action", action: "move", sound: "mira.ogg" }),
      );
      expect(seen[seen.length - 1]).toMatchObject({ actor: { name: "Mira" } });
    });

    it("falls back to the campaign default sound when the actor has none", () => {
      const campaign = new Campaign({ title: "Cues", maxRounds: 100, knownRecipes: [], actionSounds: { move: "marching.ogg" } });
      // No presentation on the character, so the cue carries no actor sound and
      // [EMIT_CUE] fills the campaign default for the action kind.
      const character = new Character({ campaign, name: "Mira", stats: makeStats(), inventorySlots: 5, actionsPerRound: 3 });
      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      character.move({ id: "r1", name: "Hall", enterRoom: () => {}, exitRoom: () => {} } as unknown as IRoom);

      expect(seen).toContainEqual(
        expect.objectContaining({ kind: "action", action: "move", sound: "marching.ogg" }),
      );
    });
  });

  describe("visibility cue", () => {
    it("entering an unlit (dark) room emits { kind: 'visibility', lit: false }", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      // The party-navigation path (move) is the cue-emitting path, not the [PLACE] seam.
      hero.move(darkRoom);
      expect(cues).toContainEqual(expect.objectContaining({ kind: "visibility", lit: false }));
    });

    it("entering a lit room emits no visibility cue", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const litRoom = new Room({ name: "Hall", description: "lit hall", loot: [] }); // not dark => isLit true
      hero.move(litRoom);
      expect(cues.some((c) => c.kind === "visibility")).toBe(false);
    });

    it("[PLACE] (mob seating) into a dark room emits NO visibility cue", () => {
      const cues: PresentationCue[] = [];
      const actor = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      // The ungated placement seam (used to seat resident/spawned mobs) is party-silent.
      actor[PLACE](darkRoom);
      expect(cues.filter((c) => c.kind === "visibility").length).toBe(0);
    });

    it("entering (via move) a dark room pre-seated with a resident mob emits EXACTLY ONE lit:false cue", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      // Seat a resident mob via placeMob -> mob[PLACE](room); this must NOT emit a cue.
      const mob = new Mob({ campaign: hero.campaign, name: "Ghoul", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [] });
      darkRoom.placeMob(mob);
      expect(cues.filter((c) => c.kind === "visibility").length).toBe(0);
      // The player then navigates in — exactly one (the player's) enter cue.
      hero.move(darkRoom);
      expect(cues.filter((c) => c.kind === "visibility").length).toBe(1);
    });

    it("entering an unlit (dark) room via move() emits { kind: 'visibility', lit: false }", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      // The real gameplay navigation path — not the [PLACE] seam — must emit the cue.
      hero.move(darkRoom);
      expect(cues).toContainEqual(expect.objectContaining({ kind: "visibility", lit: false }));
    });

    it("entering a lit room via move() emits no visibility cue", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const litRoom = new Room({ name: "Hall", description: "lit hall", loot: [] }); // not dark => isLit true
      hero.move(litRoom);
      expect(cues.some((c) => c.kind === "visibility")).toBe(false);
    });

    it("placing a light in a dark room emits { kind: 'visibility', lit: true }", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      cues.length = 0; // ignore the enter cue
      hero.placeLight(torch);
      expect(cues).toContainEqual(expect.objectContaining({ kind: "visibility", lit: true }));
    });

    it("taking the only light from a dark room emits { lit: false }", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.placeLight(torch);
      cues.length = 0;
      hero.takeLight(torch);
      expect(cues).toContainEqual(expect.objectContaining({ kind: "visibility", lit: false }));
    });

    it("equipping a hand light in a dark room flips it lit", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      cues.length = 0;
      hero.equip(torch);
      expect(cues).toContainEqual(expect.objectContaining({ kind: "visibility", lit: true }));
    });

    it("unequipping the only hand light in a dark room flips it dark", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.equip(torch);
      cues.length = 0;
      hero.unequip(torch);
      expect(cues).toContainEqual(expect.objectContaining({ kind: "visibility", lit: false }));
    });

    it("auto-swapping one hand light for another in a dark room emits no cue (net lit unchanged)", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const first = makeGear({ name: "Torch A", slot: SlotKind.Hand, emitsLight: true });
      const second = makeGear({ name: "Torch B", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(first);
      hero.addToInventory(second);
      hero.equip(first, EquipmentSlot.LeftHand);
      cues.length = 0;
      // Equipping `second` into the same hand auto-swaps `first` out; the room
      // stays lit throughout, so the transient unequip flicker must be suppressed.
      hero.equip(second, EquipmentSlot.LeftHand);
      expect(cues.some((c) => c.kind === "visibility")).toBe(false);
    });

    it("re-equipping an already-equipped hand light to another slot in a dark room emits no cue", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.equip(torch, EquipmentSlot.LeftHand);
      cues.length = 0;
      // The preliminary "free its current slot first" unequip momentarily darkens
      // the room; that flicker is suppressed, and the net state is lit→lit.
      hero.equip(torch, EquipmentSlot.RightHand);
      expect(cues.some((c) => c.kind === "visibility")).toBe(false);
    });

    it("placing a hand-equipped light in a dark room emits no cue (lit before via carry, lit after via placement)", () => {
      const cues: PresentationCue[] = [];
      const hero = makeCharacterWithCueSink(cues);
      const darkRoom = new Room({ name: "Cellar", description: "dark cellar", loot: [], dark: true });
      hero[PLACE](darkRoom);
      const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
      hero.addToInventory(torch);
      hero.equip(torch); // room is already lit by the carried light
      cues.length = 0;
      // The internal unequip would momentarily darken the room; that flicker is
      // suppressed, and since the net state is lit→lit, no cue is emitted.
      hero.placeLight(torch);
      expect(cues.some((c) => c.kind === "visibility")).toBe(false);
    });
  });

  describe("ADJUST_STAT", () => {
    it("floors a stat at 0 and reconciles", () => {
      const c = new Character({ campaign: makeCampaign(), name: "Hero", stats: makeStats() });
      const before = c.effectiveStat(StatType.Sanity);
      c[ADJUST_STAT](StatType.Sanity, -(before + 5));
      expect(c.effectiveStat(StatType.Sanity)).toBe(0); // floored, never negative
    });
  });

  describe("useMechanicAction", () => {
    it("runs the verb, applies effects, and ticks the action budget", () => {
      // The mechanic shout returns a no-op heal so the applier exercises the path
      // without needing a real target id at definition time. The actor id is
      // injected via the hook ctx at run time.
      const mechanic: LiveMechanic = {
        key: "rally",
        mechanic: {
          initialState: () => ({}),
          actions: {
            shout: {
              run: (h) => [{ kind: "heal" as const, target: h.actor.id, amount: 0 }],
            },
          },
        },
        state: {},
      };
      const campaign = new Campaign({ title: "Test", maxRounds: 100, knownRecipes: [], mechanics: [mechanic] });
      const player = new PlayerCharacter({ campaign, name: "Hero" });
      player.joinCampaign();
      assignNeutralArchetype(campaign, player);
      campaign.gm = player;
      campaign.beginCampaign();
      const before = (player as unknown as { actionsThisRound: number }).actionsThisRound;
      player.useMechanicAction("rally", "shout");
      expect((player as unknown as { actionsThisRound: number }).actionsThisRound).toBe(before + 1);
    });
  });
});
