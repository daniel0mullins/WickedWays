import { describe, expect, it } from "vitest";

import { Campaign } from "./lib/campaign";
import { HELD_BY, Item } from "./lib/inventory";
import { Loot } from "./lib/loot";
import { Room } from "./lib/room";
import { Scene } from "./lib/scene";
import { ProceduralViolation } from "./lib/util";
import { Character } from "./lib/character/character";
import { NonPlayerCharacter } from "./lib/character/non-player-character";
import { PlayerCharacter } from "./lib/character/player-character";
import { StatType } from "./lib/character/stats";
import { buildMap } from "./utils/build-map";
import { assignNeutralArchetype, type ExitsArg, makeRng, makeStats } from "./test-utils";

// A real weapon Item with inert actions/events, usable in inventories and boxes.
function makeWeapon(modifier = 3): Item {
  return new Item(
    {
      name: "Test Weapon",
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
      new Room("Entrance", "Entrance", [], {} as ExitsArg),
      new Room("Corridor", "Corridor", [], {} as ExitsArg),
      new Room("Vault", "Vault", [], {} as ExitsArg),
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

    assignNeutralArchetype(campaign, hero, seer);
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

  it("resolves combat between a player character and a co-located npc", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    // sanity 5 mitigates a 1-point unarmed health attack to exactly 1 damage,
    // and keeps the npc "normal" (fear is only below sanity 5).
    const ghoul = new NonPlayerCharacter(
      campaign,
      "Ghoul",
      makeStats({ [StatType.Sanity]: 5 }),
      "Hgrrr",
      [],
    );

    const crypt = new Room("Crypt", "Crypt", [], {} as ExitsArg);
    assignNeutralArchetype(campaign, hero);
    campaign.beginCampaign();
    hero.move(crypt);
    ghoul.move(crypt);

    expect(crypt.occupants).toContain(hero);
    expect(crypt.occupants).toContain(ghoul);

    hero.startTurn();
    hero.attack(ghoul);

    expect(ghoul.stats[StatType.Health]).toBe(9);
    expect(ghoul.isNormal).toBe(true);
  });

  it("lets a player character take loot from a co-located box", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    const sword = makeWeapon();
    const chest = new Loot("treasure chest", [sword]);
    const vault = new Room("Vault", "Vault", [chest], {} as ExitsArg);

    assignNeutralArchetype(campaign, hero);
    campaign.beginCampaign();
    hero.move(vault);
    hero.startTurn();

    const taken = hero.takeFromLootBox(chest, sword);

    expect(taken).toEqual([sword]);
    expect(hero.inventory.items).toContain(sword);
    expect(chest.contents).not.toContain(sword);
    expect(sword[HELD_BY]).toBe(hero);
  });

  it("fires a registered scene when a player character enters the room", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    let firedWithOccupants = 0;
    const trap = new Scene({
      phase: "enter",
      preconditions: [],
      script: (room) => {
        firedWithOccupants = room.occupants.length;
      },
    });
    const hall = new Room("Trapped Hall", "Trapped Hall", [], {} as ExitsArg);
    hall.registerScene(trap);

    assignNeutralArchetype(campaign, hero);
    campaign.beginCampaign();
    hero.move(hall);

    // enterRoom adds the occupant before playing scenes, so the entering hero
    // is visible to the script.
    expect(firedWithOccupants).toBe(1);
    expect(hall.occupants).toContain(hero);
  });
});
