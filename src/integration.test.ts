import { describe, expect, it } from "vitest";

import { Campaign } from "./lib/campaign";
import { Item } from "./lib/inventory";
import { Loot } from "./lib/loot";
import { Room } from "./lib/room";
import { Scene } from "./lib/scene";
import { ProceduralViolation } from "./lib/util";
import { Character } from "./lib/character/character";
import { NonPlayerCharacter } from "./lib/character/non-player-character";
import { PlayerCharacter } from "./lib/character/player-character";
import { StatType, type Stats } from "./lib/character/stats";
import { buildMap } from "./utils/build-map";

// The Room constructor types `exits` as a full Record<Direction, IRoom>, but
// at runtime it just iterates Object.entries, so an empty literal is valid.
// Match the existing room/build-map tests, which alias and cast the same way.
type ExitsArg = ConstructorParameters<typeof Room>[2];

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
    ...overrides,
  };
}

// Deterministic mulberry32 PRNG so buildMap produces a fixed topology.
function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A real weapon Item with inert actions/events, usable in inventories and boxes.
function makeWeapon(modifier = 3): Item {
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 1 },
      modifier,
      stat: StatType.Health,
    },
    { equippable: true, equipped: false, destroyable: false, usable: false },
    {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
    { onPickUp: () => {} },
  );
}

describe("Campaign integration", () => {
  it("wires every object type and runs turns until maxRounds", () => {
    const maxRounds = 3;
    const campaign = new Campaign("Wicked Ways", maxRounds);

    // Two player characters bound to the real campaign — no stubs, no casts.
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    const seer = new PlayerCharacter(campaign, "Seer", makeStats());
    hero.joinCampaign();
    seer.joinCampaign();
    campaign.gm = hero;

    // Rooms connected into a deterministic spanning tree.
    const rooms = [
      new Room("Entrance", [], {} as ExitsArg),
      new Room("Corridor", [], {} as ExitsArg),
      new Room("Vault", [], {} as ExitsArg),
    ];
    buildMap(rooms, { rng: makeRng(42), extraConnections: 1 });

    // Loot wired into a room.
    const chest = new Loot("oak chest", [makeWeapon()]);
    rooms[2]!.loot.set(chest.id, chest);

    // An NPC placed in a room.
    const npc = new NonPlayerCharacter(
      campaign,
      "Caretaker",
      makeStats(),
      "Welcome, travellers.",
      [{ type: "exact", trigger: "help", response: ["Mind the vault."] }],
    );
    npc.move(rooms[0]!);

    // A harmless scene that counts occupants when entered. Registered on the
    // starting room so the deterministically-seeded PCs are guaranteed to
    // trigger it, independent of the buildMap topology.
    let sceneEntries = 0;
    const watcher = new Scene({
      phase: "enter",
      preconditions: [],
      script: (room) => {
        sceneEntries += room.occupants.length;
      },
    });
    rooms[0]!.registerScene(watcher);

    campaign.beginCampaign();

    // Seed each PC into the first room before the loop.
    hero.move(rooms[0]!);
    seer.move(rooms[0]!);

    // Drive the turn loop. Each PC walks to a deterministic adjacent room.
    while (campaign.round < campaign.maxRounds) {
      const pc = campaign.activeCharacter;
      const exits = [...pc.currentRoom!.exits.values()];
      const next = exits[0] ?? pc.currentRoom!;
      pc.startTurn();
      pc.move(next);
      campaign.nextPlayer();
    }

    // The campaign reached maxRounds and auto-finished.
    expect(campaign.round).toBe(maxRounds);
    expect(() => campaign.nextPlayer()).toThrow(ProceduralViolation);

    // Everything stayed wired together.
    expect(campaign.party).toEqual([hero, seer]);
    expect(campaign.gm).toBe(hero);
    expect(npc.dialogue()).toEqual(["Welcome, travellers."]);
    expect(rooms[2]!.loot.get(chest.id)).toBe(chest);
    expect(sceneEntries).toBeGreaterThan(0);
    expect(npc).toBeInstanceOf(Character);
  });
});
