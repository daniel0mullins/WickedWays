import { describe, expect, it } from "vitest";

import { Campaign } from "./lib/campaign";
import type { ICampaign } from "./lib/campaign";
import { HELD_BY, Item, PLACE, createKey } from "./lib/inventory";
import { authorTemplate } from "./lib/authoring/template-builder";
import { defineRegistry } from "./lib/authoring/registry";
import { startSession } from "./lib/authoring/orchestration";
import { MaterialCache } from "./lib/material-cache";
import type { CraftingRecipe, RecipeId } from "./lib/crafting";
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
import { assignNeutralArchetype, makeRng, makeStats } from "./test-utils";
import type { ArchetypeId } from "./lib/archetype";
import { Status } from "./lib/status";
import type { PresentationCue } from "./lib/presentation";

// Sync imports
import { Authority } from "./lib/sync/authority";
import { InProcessTransport } from "./lib/sync/transport";
import { SyncCoordinator } from "./lib/sync/coordinator";
import { serializeCampaign } from "./lib/serialization/serializer";
import { deserializeCampaign } from "./lib/serialization/deserializer";
import { buildStartedCampaign, makeStats as makeStatsFixture } from "./lib/serialization/roundtrip.test-helpers";
import { SERIALIZE } from "./lib/serialization/symbols";
import { Directions } from "./lib/room";
import { EquipmentSlot } from "./lib/equipment";
import type { JsonObject, Mechanic } from "./lib/mechanics/mechanic";

// A real weapon Item with inert actions/events, usable in inventories and boxes.
function makeWeapon(modifier = 3): Item {
  return new Item({
      descriptor: {
      name: "Test Weapon",
      type: "weapon",
      recipe: { metal: 1 },
      modifier,
      stat: StatType.Health,
    },
      properties: { equippable: true, equipped: false, destroyable: false, usable: false },
      actions: {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
      events: { onPickUp: () => {} },
    });
}

// A real hand-held light source: an emitsLight Item that can be carried,
// equipped, or placed in a room.
function makeLight(name = "Candle"): Item {
  return new Item({
      descriptor: {
      name,
      type: "weapon",
      recipe: { metal: 1 },
      modifier: 0,
      stat: StatType.Health,
      slot: SlotKind.Hand,
      emitsLight: true,
    },
      properties: { equippable: true, equipped: false, destroyable: false, usable: false },
      actions: {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
      events: { onPickUp: () => {} },
    });
}

/** Standard Authority-backed wiring for sync tests. */
function wire() {
  const { campaign, registry } = buildStartedCampaign();
  const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
  const transport = new InProcessTransport(authority);
  const coordinator = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
  coordinator.start();
  return { registry, transport, coordinator };
}

describe("Campaign integration", () => {
  it("wires every object type and runs turns until maxRounds", () => {
    const maxRounds = 3;
    const campaign = new Campaign({ title: "Wicked Ways", maxRounds });

    // Two player characters bound to the real campaign — no stubs, no casts.
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats() });
    const seer = new PlayerCharacter({ campaign, name: "Seer", stats: makeStats() });
    hero.joinCampaign();
    seer.joinCampaign();
    campaign.gm = hero;

    // Rooms connected into a deterministic spanning tree.
    const rooms = [
      new Room({ name: "Entrance", description: "Entrance", loot: [] }),
      new Room({ name: "Corridor", description: "Corridor", loot: [] }),
      new Room({ name: "Vault", description: "Vault", loot: [] }),
    ];
    buildMap(rooms, { rng: makeRng(42), extraConnections: 1 });

    // Loot wired into a room.
    const chest = new Loot({ description: "oak chest", contents: [makeWeapon()] });
    rooms[2]!.loot.set(chest.id, chest);

    // An NPC placed in a room.
    const npc = new NonPlayerCharacter({ campaign, name: "Caretaker", stats: makeStats(), initialDialogue: "Welcome, travellers.", dialogueBlocks: [{ type: "exact", trigger: "help", response: ["Mind the vault."] }] });
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
    const campaign = new Campaign({ title: "Wicked Ways" });
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats() });
    hero.joinCampaign();
    campaign.gm = hero;

    // sanity 5 mitigates a 1-point unarmed health attack to exactly 1 damage,
    // and keeps the npc "normal" (fear is only below sanity 5).
    const ghoul = new NonPlayerCharacter({ campaign, name: "Ghoul", stats: makeStats({ [StatType.Sanity]: 5 }), initialDialogue: "Hgrrr", dialogueBlocks: [] });

    const crypt = new Room({ name: "Crypt", description: "Crypt", loot: [] });
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
    const campaign = new Campaign({ title: "Wicked Ways" });
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats() });
    hero.joinCampaign();
    campaign.gm = hero;

    const sword = makeWeapon();
    const chest = new Loot({ description: "treasure chest", contents: [sword] });
    const vault = new Room({ name: "Vault", description: "Vault", loot: [chest] });

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
    const campaign = new Campaign({ title: "Wicked Ways" });
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats() });
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
    const hall = new Room({ name: "Trapped Hall", description: "Trapped Hall", loot: [] });
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
    const campaign = new Campaign({ title: "Wicked Ways" });
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats({ [StatType.Energy]: 0 }), inventorySlots: 5 });
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
    const campaign = new Campaign({ title: "Wicked Ways", maxRounds: 100, knownRecipes: [], actionSounds: { move: "marching.ogg" } });
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats() });
    hero.joinCampaign();
    campaign.gm = hero;

    const coin = makeWeapon(); // any item; used as loot
    const chest = new Loot({ description: "chest", contents: [coin], presentation: { sound: "coins.ogg" } });
    const hob = new Mob({ campaign, name: "Hobgoblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [], presentation: { sound: "growl.ogg" } });
    const lair = new Room({ name: "Lair", description: "A lair", loot: [chest] });
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
    const campaign = new Campaign({ title: "Wicked Ways" });
    // Sanity 5 so the mob's 1-point unarmed Health attack lands (x1 mitigation).
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats({ [StatType.Sanity]: 5 }) });
    hero.joinCampaign();
    campaign.gm = hero;

    // The resident, light-averse mob: high Health to survive, Sanity 5 for
    // neutral (x1) mitigation of an incoming Health attack.
    const lurker = new Mob({ campaign, name: "Lurker", stats: makeStats({ [StatType.Sanity]: 5, [StatType.Health]: 30 }), inventorySlots: 2, actionsPerRound: 2, drops: [], lightAverse: true });

    const sword = makeWeapon();
    const chest = new Loot({ description: "buried cache", contents: [sword] });

    // Author-time DARK room (trailing `dark = true`) holding the mob and the box.
    const crypt = new Room({
      name: "Black Crypt",
      description: "A lightless crypt",
      loot: [chest],
      mobs: [lurker],
      dark: true,
    });

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
    const darkRoom = new Room({
      name: "Shadow Hollow",
      description: "A lightless hollow",
      loot: [],
      dark: true,
    });
    const baseline = new Mob({ campaign: lurker.campaign, name: "Lurker", stats: makeStats({ [StatType.Sanity]: 5, [StatType.Health]: 30 }), inventorySlots: 2, actionsPerRound: 2, drops: [], lightAverse: true });
    baseline[PLACE](darkRoom);
    const baselineBefore = baseline.stats[StatType.Health];
    baseline.takeDamage(1, StatType.Health); // raw strength the unarmed attack deals
    const darkDamage = baselineBefore - baseline.stats[StatType.Health];

    expect(darkDamage).toBeCloseTo(1);
    expect(litDamage).toBeCloseTo(darkDamage * LIGHT_VULNERABILITY);
  });
});

describe("Codex integration", () => {
  it("populates every kind from a scripted party run with correct first-seen stamps", () => {
    const campaign = new Campaign({ title: "Codex Run" });
    const hero = new PlayerCharacter({ campaign, name: "Hero", stats: makeStats() });
    hero.joinCampaign();

    // Room + mob (mob recorded on entry via NOTE_ENCOUNTERS).
    const cache = new MaterialCache({ contents: { metal: 2 } });
    const lair = new Room({ name: "Lair", description: "a damp lair", loot: [], materials: [cache] });
    const goblin = new Mob({ campaign, name: "Goblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [] });
    lair.enterRoom(goblin);
    hero.move(lair);

    // Item pickup that also teaches a recipe.
    const teaches: CraftingRecipe = {
      id: "iron-sword" as RecipeId,
      materials: { metal: 2 },
      create: () => makeWeapon(),
    };
    const blade = new Item({
      descriptor: { name: "Blade", type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, slot: SlotKind.Hand, teaches },
      properties: { equippable: true, equipped: false, destroyable: false, usable: false },
      actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
      events: { onPickUp: () => {} },
    });
    hero.addToInventory(blade);

    // Key pickup.
    hero.addToInventory(createKey({ name: "Lair Key", keyCode: "lair", consumeOnUse: false }));

    // Material harvest.
    hero.harvest(cache);

    const { codex } = campaign;
    expect(codex.mobs.map((e) => e.snapshot.name)).toEqual(["Goblin"]);
    expect(codex.rooms.map((e) => e.snapshot.name)).toEqual(["Lair"]);
    expect(codex.items.map((e) => e.snapshot.name)).toEqual(["Blade"]);
    expect(codex.keys.map((e) => e.snapshot.name)).toEqual(["Lair Key"]);
    expect(codex.recipes.map((e) => e.snapshot.id)).toEqual(["iron-sword"]);
    expect(codex.materials.map((e) => e.snapshot.type)).toEqual(["metal"]);

    // Every party-driven encounter is attributed to the hero.
    for (const entry of [codex.mobs[0]!, codex.rooms[0]!, codex.items[0]!, codex.keys[0]!, codex.recipes[0]!, codex.materials[0]!]) {
      expect(entry.firstSeen.characterId).toBe(hero.id);
    }
    expect(codex.size).toBe(6);
  });
});

describe("SyncCoordinator two-client convergence", () => {
  it("replica B converges to A after a removed-entity delta (consumeKey)", async () => {
    // Exercises the `delta.removed` path end-to-end: consumeKey detaches the key
    // from the character's keyring so it disappears from the serialized graph,
    // which the DeltaComputer classifies as `removed`. The applier's removed loop
    // keeps the transient index tidy, while removal from B's state is effected by
    // re-hydrating the character's changed snapshot (keyring no longer contains the
    // key). This test asserts the removed path is non-empty AND that B converges.

    // Seed the campaign with a key already on the active character's keyring so the
    // authority knows about it at startup. We achieve this by giving the active
    // character the key directly, then re-serializing as the authority's genesis.
    const { campaign, registry } = buildStartedCampaign();
    const seedActive = campaign.activeCharacter as PlayerCharacter;
    const seedKey = createKey({ name: "Vault Key", keyCode: "vault", consumeOnUse: true });
    seedActive.receiveItem(seedKey);

    const authority2 = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    const transport2 = new InProcessTransport(authority2);
    const A2 = SyncCoordinator.join({ registry, transport: transport2, rng: () => 0.5 });
    const B2 = SyncCoordinator.join({ registry, transport: transport2, rng: () => { throw new Error("replica must not roll"); } });
    A2.start(); B2.start();

    const active2 = A2.campaign.activeCharacter as PlayerCharacter;
    // Find the key in A2's campaign keyring (it was serialized in; keys go on keyring, not items)
    const key2 = [...active2.inventory.keys].find((i) => i.name === "Vault Key")!;
    expect(key2).toBeDefined();

    const res = await A2.submit({ kind: "consumeKey", actorId: active2.id, itemId: key2.id });
    if (!res.ok) throw new Error("consumeKey was rejected: " + JSON.stringify(res));
    // Verify the removed path was genuinely exercised (not a no-op).
    expect(res.delta.removed).toContain(key2.id);
    // Both clients must converge.
    expect(serializeCampaign(B2.campaign)).toEqual(serializeCampaign(A2.campaign));
  });

  it("replica B converges to A after each command", async () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    const transport = new InProcessTransport(authority);
    const A = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });
    A.start(); B.start();

    const active = A.campaign.activeCharacter;
    const dest = active.currentRoom!.exits.get(Directions.North)!;
    const res = await A.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(res.ok).toBe(true);

    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));
  });

  it("a rejected command leaves the replica's campaign unchanged", async () => {
    const { coordinator } = wire();
    const before = serializeCampaign(coordinator.campaign);
    const notActive = coordinator.campaign.party.find((p) => p.id !== coordinator.campaign.activeCharacter.id)!;
    const res = await coordinator.submit({ kind: "move", actorId: notActive.id, roomId: "r" as never });
    expect(res.ok).toBe(false);
    expect(serializeCampaign(coordinator.campaign)).toEqual(before);
  });
});

describe("SyncCoordinator join + late-join", () => {
  it("a newly joined player propagates to a replica via the created-delta", async () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    const transport = new InProcessTransport(authority);
    const A = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });
    A.start(); B.start();

    // Build a throwaway bare player off A's campaign, snapshot it, submit the join.
    const newcomer = new PlayerCharacter({ campaign: A.campaign, name: "Newcomer", stats: makeStatsFixture() });
    const res = await A.submit({ kind: "joinCampaign", character: newcomer[SERIALIZE]() });
    expect(res.ok).toBe(true);

    expect(B.campaign.party.some((p) => p.id === newcomer.id)).toBe(true);
    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));
  });

  it("late-join reconstructs from a checkpoint and replays deltas-since", async () => {
    const { campaign, registry } = buildStartedCampaign();
    // snapshotEvery: 1 so a checkpoint is written after the first commit
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5, snapshotEvery: 1 });
    const transport = new InProcessTransport(authority);
    const A = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    A.start();
    const active = A.campaign.activeCharacter;
    const dest = active.currentRoom!.exits.get(Directions.North)!;
    await A.submit({ kind: "move", actorId: active.id, roomId: dest.id });

    const C = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("no roll"); } });
    expect(serializeCampaign(C.campaign)).toEqual(serializeCampaign(A.campaign));
  });
});

describe("Victory conditions", () => {
  it("resolves 'won' with authored narration when a player enters the exit room", () => {
    // Author a registry with a single win condition keyed to the party's room.
    const reg = defineRegistry({
      items: {},
      conditions: {
        "reached-exit": (c: ICampaign) => c.party[0]?.currentRoom?.name === "exit",
      },
    });

    // Author the template: two rooms, a one-way exit, the win condition with prose.
    const campaign = startSession(
      authorTemplate("Escape Run", reg, { maxRounds: 10 })
        .archetype({ id: "scout", name: "Scout" })
        .room("start", { description: "The starting cell." })
        .room("exit", { description: "A door to freedom." })
        .startRoom("start")
        .exit("start", Directions.North, "exit")
        .winWhen("reached-exit", { text: "You escape into the night." }),
      {
        players: [{ name: "Hero", stats: { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 }, archetype: "scout" }],
        gm: 0,
      },
    );

    // The player is in the start room after startSession.
    const hero = campaign.activeCharacter;

    // Move the player into the exit room and close the round.
    hero.startTurn();
    hero.move(hero.currentRoom!.exits.get(Directions.North)!);
    campaign.nextPlayer(); // sole party member → endRound() fires → resolveOutcome() runs

    expect(campaign.outcome).toBe("won");
    expect(campaign.outcomeReason).toBe("reached-exit");
    expect(campaign.outcomeNarration?.text).toBe("You escape into the night.");
  });
});

// ---------------------------------------------------------------------------
// Custom mechanics — end-to-end integration + determinism
// ---------------------------------------------------------------------------

/**
 * Typed state for the doom-clock mechanic.
 */
interface DoomState extends JsonObject {
  doom: number;
  doomAt: number;
}

/**
 * Doom-clock: increments `doom` each round and emits a cue when the
 * threshold is reached. Also rolls the rng so the determinism test is
 * non-vacuous.
 */
const doomMechanic: Mechanic<DoomState, { doomAt: number }> = {
  initialState: (cfg) => ({ doom: 0, doomAt: cfg.doomAt }),
  onRoundEnd(h) {
    h.state.doom += 1;
    // Roll the rng — result determines flavour text, making same-seed runs
    // produce the same cue stream and different-seed runs differ.
    const roll = h.roll(6);
    const effects = [];
    if (h.state.doom >= h.state.doomAt) {
      effects.push({
        kind: "cue" as const,
        cue: { text: `Doom strikes! (roll: ${roll})` },
      });
    }
    return effects;
  },
};

/**
 * Fire-ward: if the damage target has the "ward" item equipped, halts
 * the transformer chain and reduces health damage to zero.
 */
const fireWardMechanic: Mechanic<JsonObject, void> = {
  initialState: () => ({}),
  modifyDamage(d, h) {
    const target = h.view.party.find((p) => p.id === d.target);
    if (target?.hasEquipped("ward")) {
      return { value: 0, final: true };
    }
    return d.amount;
  },
};

/** Constructs a fire-ward Item with `behaviorKey: "ward"` so it is equippable
 *  and survives serialize/hydrate via the registry. */
function makeWard(): Item {
  return new Item({
      descriptor: {
      name: "Ward",
      type: "armor",
      recipe: { metal: 1 },
      modifier: 0,
      stat: StatType.Health,
      slot: SlotKind.Torso,
      behaviorKey: "ward",
    },
      properties: { equippable: true, equipped: false, destroyable: false, usable: false },
      actions: {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
      events: { onPickUp: () => {} },
    });
}

/** Builds a started campaign using the given seed. */
function buildMechanicCampaign(seed: number) {
  const reg = defineRegistry({
    items: { ward: () => makeWard() },
    mechanics: { "fire-ward": fireWardMechanic, doom: doomMechanic },
  });
  const campaign = startSession(
    authorTemplate("Crypt", reg, { maxRounds: 10, rng: makeRng(seed) })
      .archetype({ id: "scout", name: "Scout" })
      .room("start", { description: "A cold crypt." })
      .startRoom("start")
      .useMechanic("fire-ward")
      .useMechanic("doom", { doomAt: 3 }),
    {
      players: [
        {
          name: "Hero",
          stats: {
            [StatType.Health]: 10,
            // sanity=1 keeps damageMultiplier non-zero (9*0.2=1.8) while
            // staying above the panic threshold (sanity>0).
            [StatType.Sanity]: 1,
            [StatType.Energy]: 10,
          },
          archetype: "scout",
        },
      ],
      gm: 0,
    },
  );
  return { campaign, reg };
}

/** Runs the campaign for all rounds, collecting cues. */
function runFullScenario(campaign: ReturnType<typeof buildMechanicCampaign>["campaign"]): PresentationCue[] {
  const cues: PresentationCue[] = [];
  campaign.onCue((c) => cues.push(c));
  // Advance through 3 rounds (enough to trigger doom at doomAt=3).
  for (let i = 0; i < 3; i++) {
    campaign.nextPlayer(); // sole player → endRound
  }
  return cues;
}

describe("Custom mechanics", () => {
  it("doom-clock increments state, emits threshold cue, ward zeroes damage, serialize→hydrate preserves doom", () => {
    const { campaign, reg } = buildMechanicCampaign(42);
    const hero = campaign.party[0]!;

    // === (b) Ward transformer: equip the ward and verify health damage is zeroed ===
    // Sanity=1 means damageMultiplier = (10 - 1) * 0.2 = 1.8, so a raw 5 attack
    // deals 9 to an unprotected player. With the ward, it should deal 0.
    const ward = makeWard();
    hero.receiveItem(ward);
    hero.equip(ward, EquipmentSlot.Torso);
    expect(hero.equipment.get(EquipmentSlot.Torso)?.behaviorKey).toBe("ward");

    const healthBefore = hero.stats[StatType.Health];
    hero.takeDamage(5, StatType.Health);
    expect(hero.stats[StatType.Health]).toBe(healthBefore); // ward zeroed it

    // Control: unequip, then take the same hit — health should now drop.
    hero.unequip(ward);
    const healthAfterWardOff = hero.stats[StatType.Health];
    hero.takeDamage(5, StatType.Health);
    expect(hero.stats[StatType.Health]).toBeLessThan(healthAfterWardOff);

    // === (a) Doom-clock: advance two rounds → doom=2 (below threshold, no cue yet) ===
    const cuedTexts: string[] = [];
    campaign.onCue((c) => {
      if (c.kind === "mechanic" && c.cue.text) cuedTexts.push(c.cue.text);
    });

    campaign.nextPlayer(); // round 1 ends → doom = 1
    campaign.nextPlayer(); // round 2 ends → doom = 2
    expect(cuedTexts.filter((t) => t.startsWith("Doom strikes!"))).toHaveLength(0);

    // === (c) Serialize → hydrate: doom=2 preserved; mechanic still fires ===
    const snap = serializeCampaign(campaign);
    expect(snap.campaign.mechanics).toContainEqual(
      expect.objectContaining({ key: "doom", state: { doom: 2, doomAt: 3 } }),
    );

    const restored = deserializeCampaign(snap, { registry: reg, rng: makeRng(42) });
    const restoredCues: string[] = [];
    restored.onCue((c) => {
      if (c.kind === "mechanic" && c.cue.text) restoredCues.push(c.cue.text);
    });

    // Re-equip the ward on the restored hero for the next round check.
    // (ward was unequipped and health dropped, but state/mechanics persist.)
    restored.nextPlayer(); // round 3 ends → doom = 3 → threshold hit → cue fires
    expect(restoredCues.some((t) => t.startsWith("Doom strikes!"))).toBe(true);
  });

  it("same-seed runs produce identical cue logs (rng determinism)", () => {
    const { campaign: c1 } = buildMechanicCampaign(99);
    const { campaign: c2 } = buildMechanicCampaign(99);
    const { campaign: c3 } = buildMechanicCampaign(7); // different seed

    const log1 = runFullScenario(c1);
    const log2 = runFullScenario(c2);
    const log3 = runFullScenario(c3);

    // (d) Same seed → identical cue streams.
    expect(log1).toEqual(log2);
    // Different seed → different cue stream (guards against a constant helper).
    // The doom roll text differs because h.roll(6) draws from the seeded rng.
    const mechanicCues1 = log1.filter((c) => c.kind === "mechanic");
    const mechanicCues3 = log3.filter((c) => c.kind === "mechanic");
    expect(mechanicCues1).not.toEqual(mechanicCues3);
  });
});
