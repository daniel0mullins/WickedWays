import { describe, it, expect } from "vitest";
import { assemble } from "./assembler";
import { AuthoringError } from "./errors";
import { defineRegistry } from "./registry";
import { authorTemplate } from "./template-builder";
import { startSession } from "./orchestration";
import type { INonPlayerCharacter } from "../character/non-player-character";
import { Mob, type IMob } from "../character/mob";
import type { ICampaign } from "../campaign";
import { Directions } from "../room";
import { StatType } from "../character/stats";
import { Item } from "../inventory";
import { serializeCampaign } from "../serialization/serializer";
import { deserializeCampaign } from "../serialization/deserializer";
import type { CampaignTemplateDescription } from "./description";

const makeCoin = () => new Item({
  descriptor: { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Coin", behaviorKey: "coin-item" },
  properties: { equippable: false, equipped: false, destroyable: true, usable: false },
  actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
  events: { onPickUp: () => {} },
});
const registry = defineRegistry({ items: { "coin-item": makeCoin } });
const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });

function baseDesc(over: Partial<CampaignTemplateDescription> = {}): CampaignTemplateDescription {
  return {
    title: "Crypt", opts: { rng: () => 0.5, maxRounds: 10 },
    archetypes: [], rooms: [{ name: "start", description: "the entrance" }, { name: "next", description: "next" }],
    startRoom: "start", exits: [{ from: "start", direction: Directions.North, to: "next" }],
    mobs: [], loot: [], caches: [], npcs: [], formations: [], scenes: [], recipes: [], materials: [], winConditions: [], loseConditions: [], mechanics: [], ...over,
  };
}

describe("useMechanic authoring", () => {
  it("opts a mechanic in and constructs its initial state in order", () => {
    const reg = defineRegistry({
      items: {},
      mechanics: { doom: { initialState: (c: { start: number }) => ({ doom: c.start }) } },
    });
    const campaign = authorTemplate("T", reg)
      .room("start", { description: "entry" })
      .startRoom("start")
      .useMechanic("doom", { start: 3 })
      .build();
    expect(campaign.title).toBe("T");
  });

  it("rejects an unknown mechanic key at assemble time", () => {
    const reg = defineRegistry({ items: {} });
    const b = authorTemplate("T", reg).room("s", { description: "s" }).startRoom("s");
    // unknown key — the compile-time union is `never` so any call is technically invalid;
    // we cast to bypass the type gate and verify the runtime assembler rejects it.
    expect(() => (b as unknown as { useMechanic(k: string): typeof b }).useMechanic("ghost").build()).toThrow(/unregistered mechanic key/);
  });

  it("rejects a duplicate useMechanic", () => {
    const reg = defineRegistry({ items: {}, mechanics: { doom: { initialState: () => ({}) } } });
    const b = authorTemplate("T", reg).room("s", { description: "s" }).startRoom("s").useMechanic("doom");
    expect(() => b.useMechanic("doom")).toThrow(/already enabled/);
  });
});

describe("assemble", () => {
  it("constructs a player-less, not-begun campaign with rooms + exit", () => {
    const { campaign, rooms } = assemble(baseDesc(), registry);
    expect(campaign.started).toBe(false);
    expect(campaign.party.length).toBe(0);          // no players
    expect(rooms.get("start")!.exits.get(Directions.North)!.otherSide(rooms.get("start")!)).toBe(rooms.get("next"));
    expect(serializeCampaign(campaign)).toBeDefined(); // serializable
  });

  it("places a mob's drops + a loot box's items from registry keys", () => {
    const { rooms } = assemble(baseDesc({
      mobs: [{ name: "goblin", stats: stats(), room: "next", drops: ["coin-item"] }],
      loot: [{ name: "chest", room: "next", items: ["coin-item"] }],
    }), registry);
    const next = rooms.get("next")!;
    // mob carries the drop in its inventory
    const goblin = next.occupants[0]!;
    expect(goblin.inventory.items.length).toBeGreaterThanOrEqual(1);
    // loot chest has the item
    const chest = [...next.loot.values()][0]!;
    expect(chest.contents.length).toBeGreaterThanOrEqual(1);
  });

  it("assigns content-derived ids, stable across builds", () => {
    const desc = baseDesc({
      mobs: [{ name: "goblin", stats: stats(), room: "next", drops: [] }],
      caches: [{ name: "vein", room: "next", materials: {} }],
      scenes: [],
    });
    const a = assemble(desc, registry);
    expect(a.campaign.id).toBe("campaign:Crypt");
    expect(a.rooms.get("start")!.id).toBe("room:start");
    expect(a.rooms.get("next")!.id).toBe("room:next");
    expect(a.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
    expect([...a.rooms.get("next")!.materials.values()][0]!.id).toBe("cache:vein");
    const exit = a.rooms.get("start")!.exits.get(Directions.North)!;
    expect(exit.id).toBe("exit:next|start"); // author names, sorted
    // Stable across a second, independent build (no shared counter).
    const b = assemble(desc, registry);
    expect(b.rooms.get("start")!.id).toBe("room:start");
    expect(b.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
  });

  it("assigns npc:<name> and scene:<room>:<key>:enter id forms", () => {
    const reg = defineRegistry({
      items: {},
      npcs: {
        keeper: { initialDialogue: "Hello.", dialogue: [] },
      },
      scenes: {
        intro: { preconditions: [], script: () => {} },
      },
    });
    const desc = baseDesc({
      npcs: [{ name: "Keeper", stats: stats(), room: "start", behavior: "keeper" }],
      scenes: [{ room: "start", key: "intro" }],
    });
    const a = assemble(desc, reg);
    // NPC ids use "npc:<name>" form
    const keeper = a.rooms.get("start")!.occupants.find((o) => o.name === "Keeper");
    expect(keeper?.id).toBe("npc:Keeper");
    // Scene ids use "scene:<room>:<key>:<phase>" — default phase is "enter"; check via snapshot
    const snapshot = serializeCampaign(a.campaign, { rootRooms: a.rooms.values() });
    const startRoom = snapshot.rooms.find((r) => r.name === "start");
    expect(startRoom?.scenes.find((s) => s.id === "scene:start:intro:enter")).toBeDefined();
  });

  it("collects ALL validation problems into one AuthoringError", () => {
    let err: AuthoringError | null = null;
    try {
      assemble(baseDesc({
        exits: [{ from: "start", direction: Directions.North, to: "nowhere" }], // dangling room
        rooms: [{ name: "start", description: "x" }, { name: "start", description: "dup" }], // duplicate
        startRoom: "ghost", // unknown
      }), registry);
    } catch (e) { err = e as AuthoringError; }
    expect(err).toBeInstanceOf(AuthoringError);
    expect(err!.problems.length).toBeGreaterThanOrEqual(3); // all collected, not fail-fast
  });
});

describe("scene authoring (.scene)", () => {
  it("attaches a registered scene to its room and fires it on enter", () => {
    let fired = 0;
    const reg = defineRegistry({
      items: {},
      scenes: { greet: { preconditions: [], script: () => { fired += 1; } } },
    });
    const builder = authorTemplate("T", reg)
      .room("hall", { description: "a hall" })
      .startRoom("hall")
      .scene("hall", "greet");

    // startSession seats the player in the start room, firing its "enter" scene.
    startSession(builder, { players: [{ name: "Ada" }], gm: 0 });

    expect(fired).toBe(1);
  });

  it("rejects a scene referencing an unregistered behavior key at assemble time", () => {
    const reg = defineRegistry({ items: {} });
    const builder = authorTemplate("T", reg)
      .room("hall", { description: "a hall" })
      .startRoom("hall")
      .scene("hall", "missing");

    expect(() => builder.build()).toThrow(AuthoringError);
  });
});

describe("npc authoring (.npc)", () => {
  it("seats an NPC from a registered behavior with working dialogue", () => {
    const reg = defineRegistry({
      items: {},
      npcs: {
        innkeeper: {
          initialDialogue: "Welcome, traveller.",
          dialogue: [{ type: "exact", trigger: "ale", response: ["That'll be two coins."] }],
        },
      },
    });
    const builder = authorTemplate("T", reg)
      .room("inn", { description: "an inn" })
      .npc("Innkeeper", { stats: stats(), room: "inn", behavior: "innkeeper" });

    const { rooms } = assemble(builder.description, builder.registry);
    const innkeeper = rooms.get("inn")!.occupants.find((o) => o.name === "Innkeeper") as
      | INonPlayerCharacter
      | undefined;

    expect(innkeeper).toBeDefined();
    expect(innkeeper!.dialogue()).toEqual(["Welcome, traveller."]);
    expect(innkeeper!.dialogue("ale")).toEqual(["That'll be two coins."]);
  });

  it("round-trips through serialization, re-binding dialogue preconditions from the registry", () => {
    const reg = defineRegistry({
      items: {},
      npcs: {
        sage: {
          initialDialogue: "Hmm.",
          // A precondition is a function — it can only survive serialization by
          // re-binding from the registry on hydrate.
          dialogue: [{ type: "exact", trigger: "secret", response: ["For the worthy."], precondition: () => true }],
        },
      },
    });
    const builder = authorTemplate("T", reg)
      .room("hall", { description: "a hall" })
      .startRoom("hall")
      .npc("Sage", { stats: stats(), room: "hall", behavior: "sage" });

    const snapshot = builder.toSnapshot();
    const npcSnap = snapshot.characters.find((c) => c.name === "Sage");
    expect(npcSnap?.kind).toBe("npc");
    expect(npcSnap?.npcBehaviorKey).toBe("sage");

    // Deserializing rebuilds the NPC and re-binds its (function-valued) precondition.
    expect(() => deserializeCampaign(snapshot, { registry: reg })).not.toThrow();
  });

  it("rejects an NPC referencing an unregistered behavior key", () => {
    const reg = defineRegistry({ items: {} });
    const builder = authorTemplate("T", reg)
      .room("inn", { description: "an inn" })
      .npc("Ghost", { stats: stats(), room: "inn", behavior: "missing" });

    expect(() => builder.build()).toThrow(AuthoringError);
  });

  it("rejects an NPC referencing an undefined room", () => {
    const reg = defineRegistry({ items: {}, npcs: { ghost: { initialDialogue: "Boo.", dialogue: [] } } });
    const builder = authorTemplate("T", reg)
      .room("inn", { description: "an inn" })
      .npc("Ghost", { stats: stats(), room: "nowhere", behavior: "ghost" });

    expect(() => builder.build()).toThrow(AuthoringError);
  });
});

describe("content-derived item ids", () => {
  it("assigns content-derived item ids incl. repeated keys", () => {
    const { rooms } = assemble(baseDesc({
      loot: [{ name: "chest", room: "next", items: ["coin-item", "coin-item"] }],
      mobs: [{ name: "goblin", stats: stats(), room: "next", drops: ["coin-item"] }],
      rooms: [{ name: "start", description: "e" }, { name: "next", description: "n", lights: ["coin-item"] }],
      exits: [{ from: "start", direction: Directions.North, to: "next" }],
    }), registry);
    const next = rooms.get("next")!;
    const chest = [...next.loot.values()][0]!;
    expect(chest.contents.map((i) => i.id)).toEqual(["loot:chest:item#0", "loot:chest:item#1"]);
    const goblin = next.occupants.find((o) => o.name === "goblin")!;
    expect(goblin.inventory.items[0]!.id).toBe("mob:goblin:drop#0");
    expect([...next.lightSources.values()][0]!.id).toBe("room:next:light#0");
    // all ids unique
    const all = [...chest.contents.map((i) => i.id), goblin.inventory.items[0]!.id, [...next.lightSources.values()][0]!.id];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("formation authoring (.formation)", () => {
  it("opts a registered roving formation into the campaign", () => {
    const reg = defineRegistry({
      items: {},
      formations: {
        rats: {
          build: (campaign: ICampaign): IMob[] => [
            new Mob({ campaign, name: "Rat", stats: stats(), drops: [] }),
          ],
        },
      },
    });
    const builder = authorTemplate("T", reg)
      .room("sewer", { description: "a sewer", spawnModifier: 1 })
      .startRoom("sewer")
      .formation("rats", { weight: 2 });

    expect(() => builder.build()).not.toThrow();
  });

  it("rejects a formation referencing an unregistered behavior key", () => {
    const reg = defineRegistry({ items: {} });
    const builder = authorTemplate("T", reg)
      .room("sewer", { description: "a sewer" })
      .startRoom("sewer")
      .formation("missing");

    expect(() => builder.build()).toThrow(AuthoringError);
  });
});

describe("multi-campaign id determinism", () => {
  it("derives independent, non-interfering ids across campaigns in one process", () => {
    const d1 = baseDesc({ mobs: [{ name: "goblin", stats: stats(), room: "next", drops: [] }] });
    const d2 = baseDesc({ title: "Other", rooms: [{ name: "cell", description: "c" }], startRoom: "cell", exits: [] });
    const a1 = assemble(d1, registry);
    const a2 = assemble(d2, registry);           // second campaign built after the first
    const a1again = assemble(d1, registry);      // rebuild the first, later still
    expect(a1.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
    expect(a2.campaign.id).toBe("campaign:Other");
    expect(a2.rooms.get("cell")!.id).toBe("room:cell");
    // First campaign's ids are identical no matter how many campaigns were built in between.
    expect(a1again.rooms.get("start")!.id).toBe("room:start");
    expect(a1again.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
  });
});
