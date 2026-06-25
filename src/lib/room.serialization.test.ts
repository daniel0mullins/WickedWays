import { describe, it, expect } from "vitest";
import { Room } from "./room";
import { Loot } from "./loot";
import { Item, ItemType, StatType, ADD_LIGHT_SOURCE } from "./inventory";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import { constructBareRoom } from "./room";
import { constructBareExit, SET_ENDPOINTS } from "./exit";
import { hydrateLoot } from "./loot";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";
import { SlotKind } from "./equipment";
import { reverseDirection } from "./room";

function potionFactory() {
  return new Item({
    descriptor: {
      type: ItemType.Consumable,
      recipe: { healing: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Healing Potion",
      behaviorKey: "healing-potion",
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
    actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
    events: { onPickUp: () => {} },
  });
}

function torchFactory() {
  const noop = () => {};
  return new Item({
    descriptor: {
      type: ItemType.Weapon,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Torch",
      slot: SlotKind.Hand,
      emitsLight: true,
      behaviorKey: "torch",
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

describe("Room serialization", () => {
  it("round-trips exits, loot, dark, and resolves references", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("healing-potion", potionFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const potion = potionFactory();
    const chest = new Loot({ description: "Chest", contents: [potion] });
    const north = new Room({ name: "North", description: "n", loot: [] });
    const start = new Room({ name: "Start", description: "s", loot: [chest], dark: true });
    start.addExit("north", north);

    const startSnap = start[SERIALIZE]();
    // exits is now direction -> exitId (not roomId)
    const exitId = startSnap.exits["north"];
    expect(exitId).toBeDefined();
    expect(exitId).not.toBe(north.id); // it's an exit id, not a room id
    expect(startSnap.dark).toBe(true);
    expect(startSnap.lootIds).toEqual([chest.id]);

    // pass 1: bare rooms + exit + contents indexed
    const startBare = constructBareRoom(startSnap);
    const northBare = constructBareRoom(north[SERIALIZE]());
    ctx.put(startBare.id, startBare);
    ctx.put(northBare.id, northBare);
    hydrateItem(potion[SERIALIZE](), ctx);
    hydrateLoot(chest[SERIALIZE](), ctx);

    // Construct the bare exit and index it
    const liveExit = start.exits.get("north")!;
    const exitSnap = liveExit[SERIALIZE]();
    const bareExit = constructBareExit(exitSnap);
    ctx.put(bareExit.id, bareExit);

    // pass 2: wire rooms and exit endpoints
    startBare[HYDRATE](startSnap, ctx);
    bareExit[SET_ENDPOINTS](ctx.room(exitSnap.endpointIds[0]), ctx.room(exitSnap.endpointIds[1]));

    expect(startBare.id).toBe(start.id);
    expect(startBare.isLit).toBe(false); // dark restored
    expect(startBare.exits.get("north")!.otherSide(startBare)).toBe(northBare);
    expect([...startBare.loot.keys()]).toEqual([chest.id]);
  });

  it("round-trips a placed light source into the room's lightSources and reflects isLit", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("torch", torchFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const torch = torchFactory();
    // Place the torch in a dark room via ADD_LIGHT_SOURCE (the same seam Room[HYDRATE] uses).
    const dark = new Room({ name: "Dark Chamber", description: "pitch black", loot: [], dark: true });
    dark[ADD_LIGHT_SOURCE](torch);
    expect(dark.isLit).toBe(true); // sanity: torch lights the dark room

    const darkSnap = dark[SERIALIZE]();
    expect(darkSnap.lightSourceIds).toContain(torch.id);

    // Mini two-pass hydration.
    const darkBare = constructBareRoom(darkSnap);
    ctx.put(darkBare.id, darkBare);
    hydrateItem(torch[SERIALIZE](), ctx);

    darkBare[HYDRATE](darkSnap, ctx);
    expect(darkBare.lightSources.has(torch.id as never)).toBe(true);
    expect(darkBare.isLit).toBe(true); // light source was restored
  });

  it("a shared exit round-trips as one entity referenced by both rooms", () => {
    const reg = new CampaignRegistry();
    const ctx = new HydrateContext(reg, () => 0.5);

    const roomA = new Room({ name: "Room A", description: "a" });
    const roomB = new Room({ name: "Room B", description: "b" });
    roomA.addExit("east", roomB); // bidirectional: also sets roomB.exits.west

    // Serialize both rooms
    const snapA = roomA[SERIALIZE]();
    const snapB = roomB[SERIALIZE]();

    // The exit id referenced by both rooms must be the same
    const exitIdFromA = snapA.exits["east"];
    const exitIdFromB = snapB.exits["west"];
    expect(exitIdFromA).toBeDefined();
    expect(exitIdFromB).toBeDefined();
    expect(exitIdFromA).toBe(exitIdFromB); // same exit id in both rooms

    // Pass 1: bare rooms + bare exit
    const bareA = constructBareRoom(snapA);
    const bareB = constructBareRoom(snapB);
    ctx.put(bareA.id, bareA);
    ctx.put(bareB.id, bareB);

    const liveExit = roomA.exits.get("east")!;
    const exitSnap = liveExit[SERIALIZE]();
    const bareExit = constructBareExit(exitSnap);
    ctx.put(bareExit.id, bareExit);

    // Pass 2: wire rooms and exit endpoints
    bareA[HYDRATE](snapA, ctx);
    bareB[HYDRATE](snapB, ctx);
    bareExit[SET_ENDPOINTS](ctx.room(exitSnap.endpointIds[0]), ctx.room(exitSnap.endpointIds[1]));

    // The exit object is the SAME instance in both rooms
    const exitFromA = bareA.exits.get("east")!;
    const exitFromB = bareB.exits.get(reverseDirection("east"))!;
    expect(exitFromA).toBe(exitFromB); // same Exit object

    // And otherSide resolves correctly
    expect(exitFromA.otherSide(bareA)).toBe(bareB);
    expect(exitFromB.otherSide(bareB)).toBe(bareA);
  });
});
