import { describe, expect, it } from "vitest";

import { Campaign } from "../campaign";
import { ADD_LIGHT_SOURCE, Item, PLACE } from "../inventory";
import { Room } from "../room";
import { SlotKind } from "../equipment";
import { ProceduralViolation } from "../util";
import { Mob } from "./mob";
import { StatType } from "./stats";

import { type ExitsArg, makeCampaign, makeDefender, makeStats } from "../../test-utils";

// A concrete Combatant for exercising the inherited `attack` gate. Combatant is
// abstract, so we drive it through its real Mob subclass.
function makeAttacker(campaign: Campaign = makeCampaign() as Campaign): Mob {
  return new Mob(campaign, "Goblin", makeStats(), 2, 2, []);
}

// Only the item's `id` and `emitsLight` flag matter; the rest satisfies Item.
function makeLight(): Item {
  const noop = () => {};
  return new Item(
    { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Candle", slot: SlotKind.Hand, emitsLight: true },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

describe("Combatant.attack darkness gate", () => {
  // Build a real authored-dark Room and co-locate the attacker via the
  // engine-internal [PLACE] seam (sets currentRoom + occupancy).
  function darkRoomWithAttacker() {
    const room = new Room("Cellar", "dark cellar", [], {} as ExitsArg, [], 1, [], undefined, true);
    const attacker = makeAttacker();
    attacker[PLACE](room);
    return { room, attacker };
  }

  it("throws when attacking in an unlit room and the attacker cannot see in the dark", () => {
    const { attacker } = darkRoomWithAttacker();
    expect(attacker.seesInDark).toBe(false);
    expect(() => attacker.attack(makeDefender())).toThrow(ProceduralViolation);
  });

  it("does not throw once the room is lit by a placed light source", () => {
    const { room, attacker } = darkRoomWithAttacker();
    room[ADD_LIGHT_SOURCE](makeLight());
    expect(room.isLit).toBe(true);
    expect(() => attacker.attack(makeDefender())).not.toThrow();
  });

  it("never gates light actions: placeLight works in the dark and lights the room", () => {
    const { room, attacker } = darkRoomWithAttacker();
    const torch = makeLight();
    attacker.addToInventory(torch);
    expect(() => attacker.placeLight(torch)).not.toThrow();
    expect(room.isLit).toBe(true);
  });

  it("allows a seesInDark attacker to attack in the dark", () => {
    // A minimal subclass standing in for Task 8's light-averse mob: it can see
    // in the dark, so the gate must let it through. (Task 8 wires this onto Mob.)
    class BlindSeer extends Mob {
      override get seesInDark() {
        return true;
      }
    }
    const room = new Room("Cellar", "dark cellar", [], {} as ExitsArg, [], 1, [], undefined, true);
    const seer = new BlindSeer(makeCampaign(), "Lurker", makeStats(), 2, 2, []);
    seer[PLACE](room);
    expect(room.isLit).toBe(false);
    expect(() => seer.attack(makeDefender())).not.toThrow();
  });
});
