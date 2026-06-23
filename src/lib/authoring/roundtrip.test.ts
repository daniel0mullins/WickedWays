/**
 * Full round-trip integration test for the authoring template snapshot.
 *
 * Core promise: a template snapshot produced by `.toSnapshot()` must be
 * hydratable by `deserializeCampaign` — every entity kind (rooms, dark rooms,
 * exits, mobs with drops, loot, caches, light sources, archetypes, recipes,
 * and materials) must survive the round-trip without throwing.
 *
 * If a future change causes `.toSnapshot()` to produce an unhydratable snapshot
 * (e.g. a missing behaviorKey), `deserializeCampaign` will throw and this test
 * will fail.
 */
import { describe, it, expect } from "vitest";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { assemble } from "./assembler";
import { deserializeCampaign } from "../serialization/deserializer";
import { serializeCampaign } from "../serialization/serializer";
import { Directions } from "../room";
import { StatType } from "../character/stats";
import { Item } from "../inventory";
import type { RecipeId } from "../crafting";
import type { ICampaign } from "../campaign";

// ---------------------------------------------------------------------------
// Item / recipe factories — every behaviorKey must be registered in the
// registry so hydrateItem can look them up during deserializeCampaign.
// ---------------------------------------------------------------------------

const COIN_KEY = "coin-item";
const TORCH_KEY = "torch-item";
const POTION_KEY = "potion-item";
const RECIPE_KEY = "coin-recipe";

const makeCoin = () =>
  new Item({
    descriptor: {
      type: "consumable",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Coin",
      behaviorKey: COIN_KEY,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
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

const makeTorch = () =>
  new Item({
    descriptor: {
      type: "consumable",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Torch",
      behaviorKey: TORCH_KEY,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
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

const makePotion = () =>
  new Item({
    descriptor: {
      type: "consumable",
      recipe: { healing: 1 },
      modifier: 5,
      stat: StatType.Health,
      name: "Potion",
      behaviorKey: POTION_KEY,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
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

const coinRecipe = {
  id: RECIPE_KEY as RecipeId,
  materials: { item: 3 },
  create: makeCoin,
};

// ---------------------------------------------------------------------------
// Registry — every behaviorKey/recipe the template references must be here.
// ---------------------------------------------------------------------------

const registry = defineRegistry({
  items: {
    [COIN_KEY]: makeCoin,
    [TORCH_KEY]: makeTorch,
    [POTION_KEY]: makePotion,
  },
  recipes: {
    [RECIPE_KEY]: coinRecipe,
  },
});

// ---------------------------------------------------------------------------
// Template description (shared between builder and assemble calls so the
// re-serialization step can obtain live Room instances for rootRooms).
// ---------------------------------------------------------------------------

const TITLE = "Round-Trip Dungeon";

function buildSnapshot() {
  return authorTemplate(TITLE, registry, { rng: () => 0.5, maxRounds: 20 })
    // Two rooms — one dark (exercises dark-room hydration).
    .room("entrance", { description: "The entrance hall.", dark: false })
    .room("vault", { description: "A pitch-dark vault.", dark: true, lights: [TORCH_KEY] })
    // Start room.
    .startRoom("entrance")
    // Directional exit (exercises exit hydration).
    .exit("entrance", Directions.North, "vault")
    // Mob with drops (exercises mob + item-drop hydration).
    .mob("Guard", {
      stats: { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 8 },
      room: "vault",
      drops: [COIN_KEY],
    })
    // Loot box (exercises LootBox + items hydration).
    .loot("treasure chest", { room: "entrance", items: [POTION_KEY, COIN_KEY] })
    // Material cache (exercises MaterialCache hydration).
    .cache("stone pile", { room: "vault", materials: { item: 5 } })
    // Archetype (exercises catalog hydration).
    .archetype({ id: "warrior", name: "Warrior", statModifiers: { [StatType.Health]: 3 } })
    // Recipe unlock (exercises recipe catalog hydration).
    .recipe(RECIPE_KEY)
    // Initial materials (exercises campaign material pool hydration).
    .materials("starter-cache", { item: 2 })
    .toSnapshot();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("template round-trip (toSnapshot → deserializeCampaign)", () => {
  it("deserializes without throwing — every entity kind hydratable", () => {
    const snap = buildSnapshot();
    // deserializeCampaign throws ProceduralViolation if any behaviorKey is
    // unregistered or a cross-reference is dangling — this is the acceptance gate.
    expect(() => deserializeCampaign(snap, { registry, rng: () => 0.5 })).not.toThrow();
  });

  it("restores a player-less, not-yet-started campaign with the correct title", () => {
    const snap = buildSnapshot();
    const restored = deserializeCampaign(snap, { registry, rng: () => 0.5 });
    expect(restored.title).toBe(TITLE);
    expect(restored.started).toBe(false);
    expect(restored.party.length).toBe(0);
  });

  it("snapshot contains every expected entity kind (rooms, loot, caches, items)", () => {
    const snap = buildSnapshot();
    // 2 rooms (entrance + vault).
    expect(snap.rooms.length).toBe(2);
    // 1 loot box.
    expect(snap.loot.length).toBe(1);
    // 1 material cache.
    expect(snap.materialCaches.length).toBe(1);
    // Items: 2 in loot (potion + coin) + 1 light placed in vault (torch)
    // + mob's drop item (coin) in mob inventory.
    expect(snap.items.length).toBeGreaterThanOrEqual(3);
    // A dark room must be present.
    const darkRoom = snap.rooms.find((r) => r.dark === true);
    expect(darkRoom).toBeDefined();
    expect(darkRoom?.name).toBe("vault");
    // An exit must be wired (exits is a Record<direction, roomId>).
    const entranceSnap = snap.rooms.find((r) => r.name === "entrance");
    expect(Object.keys(entranceSnap?.exits ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it("re-serializing the restored campaign with rootRooms reproduces structural equivalence", () => {
    const snap = buildSnapshot();
    const restored = deserializeCampaign(snap, { registry, rng: () => 0.5 });

    // Campaign has no public all-rooms accessor, so we obtain live Room
    // instances by re-assembling from the same builder description, then pass
    // them as rootRooms for the re-serialization call.
    const builder = authorTemplate(TITLE, registry, { rng: () => 0.5, maxRounds: 20 })
      .room("entrance", { description: "The entrance hall.", dark: false })
      .room("vault", { description: "A pitch-dark vault.", dark: true, lights: [TORCH_KEY] })
      .startRoom("entrance")
      .exit("entrance", Directions.North, "vault")
      .mob("Guard", {
        stats: { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 8 },
        room: "vault",
        drops: [COIN_KEY],
      })
      .loot("treasure chest", { room: "entrance", items: [POTION_KEY, COIN_KEY] })
      .cache("stone pile", { room: "vault", materials: { item: 5 } })
      .archetype({ id: "warrior", name: "Warrior", statModifiers: { [StatType.Health]: 3 } })
      .recipe(RECIPE_KEY)
      .materials("starter-cache", { item: 2 });

    const { rooms } = assemble(builder.description, registry);

    // Re-serialize the hydrated restored campaign using the live rooms as BFS roots.
    const snap2 = serializeCampaign(restored, { rootRooms: rooms.values() });

    // Structural equivalence: same counts and same room names / exits.
    expect(snap2.rooms.length).toBe(snap.rooms.length);
    expect(snap2.loot.length).toBe(snap.loot.length);
    expect(snap2.materialCaches.length).toBe(snap.materialCaches.length);
    expect(snap2.items.length).toBe(snap.items.length);
    expect(snap2.rooms.map((r) => r.name).sort()).toEqual(
      snap.rooms.map((r) => r.name).sort(),
    );
    // exits is a Record<direction, roomId> in the snapshot.
    expect(
      snap2.rooms.map((r) => Object.keys(r.exits).sort()).sort(),
    ).toEqual(
      snap.rooms.map((r) => Object.keys(r.exits).sort()).sort(),
    );
  });

  it("round-trips an authored template's victory conditions and prose", () => {
    const condRegistry = defineRegistry({
      items: {},
      conditions: { "reached-exit": (_c: ICampaign) => true },
    });
    const snap = authorTemplate("Escape", condRegistry)
      .room("start", { description: "the cell" })
      .startRoom("start")
      .winWhen("reached-exit", { text: "Free at last." })
      .toSnapshot();

    const restored = deserializeCampaign(snap, { registry: condRegistry });
    expect(restored.outcome).toBe("ongoing"); // template not yet played
    // The predicate re-attached: serialize again and the key survives.
    const { rooms: condRooms } = assemble(
      authorTemplate("Escape", condRegistry)
        .room("start", { description: "the cell" })
        .startRoom("start")
        .winWhen("reached-exit", { text: "Free at last." })
        .description,
      condRegistry,
    );
    const re = serializeCampaign(restored, { rootRooms: condRooms.values() });
    expect(re.campaign.winConditions).toEqual([{ key: "reached-exit", narration: { text: "Free at last." } }]);
  });

  it("throws when a registry is missing a required behaviorKey (guards unhydratable snapshots)", () => {
    // Produce a valid snapshot with the full registry (assembler needs all keys).
    const snap = buildSnapshot();

    // A partial registry deliberately missing POTION_KEY — the snapshot
    // references the potion item, so deserializeCampaign must throw.
    const partialRegistry = defineRegistry({
      items: {
        [COIN_KEY]: makeCoin,
        [TORCH_KEY]: makeTorch,
        // POTION_KEY intentionally omitted
      },
      recipes: { [RECIPE_KEY]: coinRecipe },
    });

    expect(() =>
      deserializeCampaign(snap, { registry: partialRegistry, rng: () => 0.5 }),
    ).toThrow();
  });
});
