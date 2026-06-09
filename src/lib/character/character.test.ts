import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM, createKey, type IItem, type ItemId } from "../inventory";
import type { IRoom, RoomId } from "../room";
import { Status } from "../status";
import { ProceduralViolation } from "../util";

import type { ICampaign } from "../campaign";
import { Character } from "./character";
import type { ActionHistoryEntry } from "./history";
import { StatType, type Stats } from "./stats";

import { makeCampaign, makeStats } from "../../test-utils";

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
        // Energy mitigated by Health 0 => multiplier 2.
        stats: { [StatType.Energy]: 3, [StatType.Health]: 0 },
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
      // while #resolveStatuses runs over the unchanged stats.
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
      const character = new Character(
        { round: 7 } as unknown as ICampaign,
        "Hero",
        makeStats(),
      );
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
});
