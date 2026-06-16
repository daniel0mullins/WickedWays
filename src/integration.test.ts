import { describe, expect, it } from "vitest";

import { Campaign } from "./lib/campaign";
import { HELD_BY, Item, PLACE } from "./lib/inventory";
import { Loot } from "./lib/loot";
import { Room } from "./lib/room";
import { Scene } from "./lib/scene";
import { ProceduralViolation } from "./lib/util";
import { Character, LIGHT_VULNERABILITY } from "./lib/character/character";
import { Mob } from "./lib/character/mob";
import { NonPlayerCharacter } from "./lib/character/non-player-character";
import { PlayerCharacter } from "./lib/character/player-character";
import { StatType } from "./lib/character/stats";
import { SlotKind } from "./lib/equipment";
import { buildMap } from "./utils/build-map";
import { assignNeutralArchetype, type ExitsArg, makeRng, makeStats } from "./test-utils";
import type { ArchetypeId } from "./lib/archetype";
import { Status } from "./lib/status";
import type { PresentationCue } from "./lib/presentation";

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

// A real hand-held light source: an emitsLight Item that can be carried,
// equipped, or placed in a room.
function makeLight(name = "Candle"): Item {
  return new Item(
    {
      name,
      type: "weapon",
      recipe: { metal: 1 },
      modifier: 0,
      stat: StatType.Health,
      slot: SlotKind.Hand,
      emitsLight: true,
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

  it("applies a selected archetype's stat, slot, and immunity effects through setup", () => {
    const campaign = new Campaign("Wicked Ways");
    const hero = new PlayerCharacter(campaign, "Hero", makeStats({ [StatType.Energy]: 0 }), 5);
    hero.joinCampaign();
    campaign.gm = hero;

    campaign.registerArchetype({
      id: "stoic-packer" as ArchetypeId,
      name: "Stoic Packer",
      statModifiers: { [StatType.Health]: 2 },
      inventorySlots: 3,
      immunities: [Status.Confused],
    });
    hero.selectArchetype("stoic-packer" as ArchetypeId);
    campaign.beginCampaign();

    // Stat delta layered on the base.
    expect(hero.stats[StatType.Health]).toBe(12);
    // Slot delta applied to capacity.
    expect(hero.inventory.slots).toBe(8);

    // Standing immunity holds through a reconcile that would otherwise latch Confused.
    hero.startTurn();
    hero.takeDamage(0, StatType.Energy);
    expect(hero.status).not.toContain(Status.Confused);
  });

  it("emits action and encounter cues with resolved sounds across a turn", () => {
    const campaign = new Campaign("Wicked Ways", 100, [], { actionSounds: { move: "marching.ogg" } });
    const hero = new PlayerCharacter(campaign, "Hero", makeStats());
    hero.joinCampaign();
    campaign.gm = hero;

    const coin = makeWeapon(); // any item; used as loot
    const chest = new Loot("chest", [coin], { sound: "coins.ogg" });
    const hob = new Mob(campaign, "Hobgoblin", makeStats(), 2, 2, [], { presentation: { sound: "growl.ogg" } });
    const lair = new Room("Lair", "A lair", [chest], {} as ExitsArg);
    lair.placeMob(hob);

    // Archetype requirement from the prior feature: give the PC a neutral one.
    assignNeutralArchetype(campaign, hero);
    campaign.beginCampaign();

    const cues: PresentationCue[] = [];
    campaign.onCue((cue) => cues.push(cue));

    hero.startTurn();
    hero.move(lair);                 // move cue (marching) + encounter cue (growl)
    hero.takeFromLootBox(chest, coin); // pickUp cue (coins, from the container)

    expect(cues).toContainEqual(expect.objectContaining({ kind: "action", action: "move", sound: "marching.ogg" }));
    expect(cues).toContainEqual(expect.objectContaining({ kind: "encounter", mob: expect.objectContaining({ name: "Hobgoblin" }), sound: "growl.ogg" }));
    expect(cues).toContainEqual(expect.objectContaining({ kind: "action", action: "pickUp", sound: "coins.ogg" }));
  });
});

// End-to-end proof of the darkness mechanic: a dark room conceals its contents
// so a player can't target the resident mob or loot, but the light-averse mob —
// which sees in the dark — can attack freely. Lighting the room flips the gate
// open and makes the light-averse mob take amplified damage.
//
// Mitigation is held neutral so the light multiplier is the only variable: a
// Health attack is mitigated by Sanity, and Sanity 5 yields a (10 - 5) * 0.2 = 1.0
// multiplier, so raw strength passes through unchanged with no armor. Mob Health
// is raised to 30 so the amplified hit lands without the floor-at-0 clamp.
describe("darkness mechanic", () => {
  function darknessSetup() {
    const campaign = new Campaign("Wicked Ways");
    // Sanity 5 so the mob's 1-point unarmed Health attack lands (x1 mitigation).
    const hero = new PlayerCharacter(campaign, "Hero", makeStats({ [StatType.Sanity]: 5 }));
    hero.joinCampaign();
    campaign.gm = hero;

    // The resident, light-averse mob: high Health to survive, Sanity 5 for
    // neutral (x1) mitigation of an incoming Health attack.
    const lurker = new Mob(
      campaign,
      "Lurker",
      makeStats({ [StatType.Sanity]: 5, [StatType.Health]: 30 }),
      2,
      2,
      [],
      { lightAverse: true },
    );

    const sword = makeWeapon();
    const chest = new Loot("buried cache", [sword]);

    // Author-time DARK room (trailing `dark = true`) holding the mob and the box.
    const crypt = new Room(
      "Black Crypt",
      "A lightless crypt",
      [chest],
      {} as ExitsArg,
      [],
      1,
      [lurker],
      undefined,
      true,
    );

    assignNeutralArchetype(campaign, hero);
    campaign.beginCampaign();

    const cues: PresentationCue[] = [];
    campaign.onCue((cue) => cues.push(cue));

    return { campaign, hero, lurker, sword, chest, crypt, cues };
  }

  it("conceals targets in the dark, then lighting it opens the gate and amplifies damage", () => {
    const { hero, lurker, sword, chest, crypt, cues } = darknessSetup();

    // 1) The hero enters the dark room via the real `move` gameplay path
    //    (movement is never darkness-gated). The enter path emits a "not lit" cue.
    hero.move(crypt);
    expect(hero.currentRoom).toBe(crypt);
    expect(crypt.isLit).toBe(false);
    expect(cues).toContainEqual(
      expect.objectContaining({ kind: "visibility", lit: false }),
    );

    hero.startTurn();

    // 2) While unlit, the hero cannot loot or attack — both are gated.
    expect(() => hero.takeFromLootBox(chest, sword)).toThrow(ProceduralViolation);
    expect(() => hero.attack(lurker)).toThrow(ProceduralViolation);

    // 3) The light-averse mob sees in the dark, so its attack lands and hurts.
    expect(lurker.seesInDark).toBe(true);
    const heroHealthBefore = hero.stats[StatType.Health];
    lurker.startTurn();
    expect(() => lurker.attack(hero)).not.toThrow();
    expect(hero.stats[StatType.Health]).toBeLessThan(heroHealthBefore);

    // 4) The hero lights the room by placing a candle. The flip emits a "lit" cue.
    const candle = makeLight();
    hero.receiveItem(candle);
    cues.length = 0; // ignore everything up to the deliberate flip
    hero.placeLight(candle);
    expect(crypt.isLit).toBe(true);
    expect(cues).toContainEqual(
      expect.objectContaining({ kind: "visibility", lit: true }),
    );

    // 5) While lit, the hero CAN now attack the mob — the gate is open.
    const mobHealthBefore = lurker.stats[StatType.Health];
    hero.startTurn();
    expect(() => hero.attack(lurker)).not.toThrow();
    const litDamage = mobHealthBefore - lurker.stats[StatType.Health];

    // 6) The damage is LIGHT_VULNERABILITY-amplified. Baseline: the same raw
    //    1-point unarmed Health attack against an identical light-averse mob in
    //    a dark room (computed directly, since the hero can't attack in the dark).
    const darkRoom = new Room(
      "Shadow Hollow",
      "A lightless hollow",
      [],
      {} as ExitsArg,
      [],
      1,
      [],
      undefined,
      true,
    );
    const baseline = new Mob(
      lurker.campaign,
      "Lurker",
      makeStats({ [StatType.Sanity]: 5, [StatType.Health]: 30 }),
      2,
      2,
      [],
      { lightAverse: true },
    );
    baseline[PLACE](darkRoom);
    const baselineBefore = baseline.stats[StatType.Health];
    baseline.takeDamage(1, StatType.Health); // raw strength the unarmed attack deals
    const darkDamage = baselineBefore - baseline.stats[StatType.Health];

    expect(darkDamage).toBeCloseTo(1);
    expect(litDamage).toBeCloseTo(darkDamage * LIGHT_VULNERABILITY);
  });
});
