import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ICampaign } from "../campaign";
import type { IItem, ItemId } from "../inventory";
import type { IRoom } from "../room";
import { Status } from "../status";
import { ProceduralViolation } from "../util";

import { Character } from "./character";
import { StatType, type Stats } from "./stats";

// ---------------------------------------------------------------------------
// Test doubles
//
// Character only stores the campaign and exposes it via a getter, so a bare
// stub is enough. Rooms and items are interacted with through a small, known
// surface, so we fake just the methods Character touches.
// ---------------------------------------------------------------------------

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
function makeItem(id?: string): IItem {
  const itemId = (id ?? `item-${++itemCounter}`) as ItemId;
  return {
    id: itemId,
    actions: { pickUp: vi.fn() },
  } as unknown as IItem;
}

function makeRoom(): IRoom {
  return {
    enterRoom: vi.fn(),
    exitRoom: vi.fn(),
  } as unknown as IRoom;
}

function makeCharacter(opts: {
  stats?: Partial<Stats>;
  inventorySlots?: number;
  actionsPerRound?: number;
} = {}) {
  return new Character(
    makeCampaign(),
    "Hero",
    makeStats(opts.stats),
    opts.inventorySlots,
    opts.actionsPerRound,
  );
}

describe("Character", () => {
  beforeEach(() => {
    itemCounter = 0;
  });

  describe("constructor", () => {
    it("assigns a generated id and the provided name and stats", () => {
      const stats = makeStats({ [StatType.Health]: 7 });
      const character = new Character(makeCampaign(), "Mira", stats);

      expect(typeof character.id).toBe("string");
      expect(character.id.length).toBeGreaterThan(0);
      expect(character.name).toBe("Mira");
      expect(character.stats).toBe(stats);
    });

    it("exposes the campaign passed to the constructor", () => {
      const campaign = makeCampaign();
      const character = new Character(campaign, "Hero", makeStats());

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
        // Energy mitigated by Health 0 => multiplier 2.
        stats: { [StatType.Energy]: 3, [StatType.Health]: 0 },
      });

      character.takeDamage(10, StatType.Energy);

      expect(character.stats[StatType.Energy]).toBe(0);
      expect(character.status).toContain(Status.Confused);
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

      character.recordAction(function notAnAction() {});
      character.recordAction(() => {});

      expect(onTurnEnd).not.toHaveBeenCalled();
    });
  });
});
