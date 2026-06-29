import { describe, it, expect } from "vitest";
import { sceneHotspots, inventoryActions } from "./affordances.js";
import type { ActionDescriptor } from "./affordances.js";
import type { ViewModel, ScopeEntity, LootView } from "@wickedways/play-runtime";
import { Directions } from "wickedways/lib/room";

// ── Test helpers ───────────────────────────────────────────────────────────

const mkVm = (over: Partial<ViewModel> = {}): ViewModel => ({
  room: { id: "r", name: "Hall", description: "a hall", isLit: true },
  exits: [],
  lockedDoors: [],
  occupants: [],
  loot: [],
  inventory: { items: [], keys: [], equippedNames: [], slots: 6 },
  scope: [],
  status: { locationName: "Hall", turn: 1, maxTurns: 150, sanity: 10, health: 10 },
  outcome: "ongoing",
  finished: false,
  ...over,
});

const ent = (
  id: string,
  name: string,
  kind: ScopeEntity["kind"],
  extras: Partial<ScopeEntity> = {},
): ScopeEntity => ({
  id,
  name,
  aliases: [name.toLowerCase()],
  kind,
  ...extras,
});

// ── Exits ──────────────────────────────────────────────────────────────────

describe("sceneHotspots — exits", () => {
  it("passable exit produces kind:exit with a Go-<Dir> move intent", () => {
    const vm = mkVm({ exits: [{ dir: Directions.North, toName: "Landing" }] });
    const hotspots = sceneHotspots(vm);
    expect(hotspots).toHaveLength(1);
    const h = hotspots[0]!;
    expect(h.kind).toBe("exit");
    expect(h.key).toBe("north");
    expect(h.label).toBe("North");
    expect(h.dir).toBe("north");
    expect(h.actions).toEqual([
      { label: "Go North", kind: "intent", intent: { kind: "move", dir: "north" } },
    ]);
  });

  it("capitalises all 8 directions correctly", () => {
    const dirs = [
      Directions.North,
      Directions.South,
      Directions.East,
      Directions.West,
      Directions.Northeast,
      Directions.Northwest,
      Directions.Southeast,
      Directions.Southwest,
    ];
    const vm = mkVm({ exits: dirs.map((dir) => ({ dir, toName: "Room" })) });
    const labels = sceneHotspots(vm).map((h) => h.label);
    expect(labels).toEqual([
      "North",
      "South",
      "East",
      "West",
      "Northeast",
      "Northwest",
      "Southeast",
      "Southwest",
    ]);
  });

  it("each exit action label matches the capitalised direction", () => {
    const vm = mkVm({ exits: [{ dir: Directions.Southwest, toName: "Cave" }] });
    const [h] = sceneHotspots(vm);
    expect(h!.actions[0]).toEqual({
      label: "Go Southwest",
      kind: "intent",
      intent: { kind: "move", dir: "southwest" },
    });
  });
});

// ── Locked doors ───────────────────────────────────────────────────────────

describe("sceneHotspots — locked doors", () => {
  it("locked door produces kind:locked, empty actions, key=dir, label contains door name", () => {
    const vm = mkVm({ lockedDoors: [{ name: "Iron Gate", dir: Directions.East }] });
    const hotspots = sceneHotspots(vm);
    expect(hotspots).toHaveLength(1);
    const h = hotspots[0]!;
    expect(h.kind).toBe("locked");
    expect(h.key).toBe("east");
    expect(h.dir).toBe("east");
    expect(h.label).toContain("Iron Gate");
    expect(h.actions).toEqual([]);
  });

  it("unnamed locked door still produces an empty actions array", () => {
    const vm = mkVm({ lockedDoors: [{ name: "door", dir: Directions.West }] });
    const [h] = sceneHotspots(vm);
    expect(h!.kind).toBe("locked");
    expect(h!.actions).toEqual([]);
  });
});

// ── Occupants ─────────────────────────────────────────────────────────────

describe("sceneHotspots — occupants", () => {
  it("living occupant offers Examine + Attack", () => {
    const mob = ent("mob-1", "Revenant", "occupant");
    const vm = mkVm({ occupants: [mob] });
    const [h] = sceneHotspots(vm);
    expect(h!.kind).toBe("occupant");
    expect(h!.key).toBe("mob-1");
    expect(h!.label).toBe("Revenant");
    expect(h!.actions).toEqual([
      { label: "Examine", kind: "examine", targetId: "mob-1" },
      { label: "Attack", kind: "intent", intent: { kind: "attack", targetId: "mob-1" } },
    ]);
  });

  it("defeated occupant offers only Examine", () => {
    const mob = ent("mob-2", "Wraith", "occupant", { defeated: true });
    const vm = mkVm({ occupants: [mob] });
    const [h] = sceneHotspots(vm);
    expect(h!.kind).toBe("occupant");
    expect(h!.actions).toEqual([
      { label: "Examine", kind: "examine", targetId: "mob-2" },
    ]);
  });

  it("carries image from occupant entity when present", () => {
    const mob = ent("mob-3", "Ghost", "occupant", { image: "ghost.png" });
    const vm = mkVm({ occupants: [mob] });
    const [h] = sceneHotspots(vm);
    expect(h!.image).toBe("ghost.png");
  });

  it("does not set image when occupant has no image", () => {
    const mob = ent("mob-4", "Shade", "occupant");
    const vm = mkVm({ occupants: [mob] });
    const [h] = sceneHotspots(vm);
    expect(h!.image).toBeUndefined();
  });
});

// ── Loot ──────────────────────────────────────────────────────────────────

describe("sceneHotspots — loot containers", () => {
  it("loot produces kind:loot with Examine + Open", () => {
    const loot: LootView = { id: "chest-1", description: "an old chest", opened: false, contents: [] };
    const vm = mkVm({ loot: [loot] });
    const [h] = sceneHotspots(vm);
    expect(h!.kind).toBe("loot");
    expect(h!.key).toBe("chest-1");
    expect(h!.label).toBe("an old chest");
    expect(h!.actions).toEqual([
      { label: "Examine", kind: "examine", targetId: "chest-1" },
      { label: "Open", kind: "intent", intent: { kind: "open", targetId: "chest-1" } },
    ]);
  });

  it("opened loot still offers Examine + Open (session handles the opened state)", () => {
    const loot: LootView = { id: "chest-2", description: "an open chest", opened: true, contents: [] };
    const vm = mkVm({ loot: [loot] });
    const [h] = sceneHotspots(vm);
    expect(h!.actions).toHaveLength(2);
    expect(h!.actions[1]).toMatchObject({ kind: "intent", intent: { kind: "open" } });
  });
});

// ── Floor items ────────────────────────────────────────────────────────────

describe("sceneHotspots — floor items", () => {
  it("scope item not in inventory and not in loot contents → Examine + Take", () => {
    const floorItem = ent("lantern-1", "Brass Lantern", "item", { image: "lantern.png" });
    const vm = mkVm({ scope: [floorItem] });
    const [h] = sceneHotspots(vm);
    expect(h!.kind).toBe("item");
    expect(h!.key).toBe("lantern-1");
    expect(h!.label).toBe("Brass Lantern");
    expect(h!.image).toBe("lantern.png");
    expect(h!.actions).toEqual([
      { label: "Examine", kind: "examine", targetId: "lantern-1" },
      { label: "Take", kind: "intent", intent: { kind: "take", targetId: "lantern-1" } },
    ]);
  });

  it("inventory items are excluded from floor hotspots", () => {
    const invItem = ent("key-1", "Brass Key", "item");
    const vm = mkVm({
      scope: [invItem],
      inventory: { items: [invItem], keys: [], equippedNames: [], slots: 6 },
    });
    const hotspots = sceneHotspots(vm);
    expect(hotspots.every((h) => h.key !== "key-1")).toBe(true);
  });

  it("inventory keys are excluded from floor hotspots", () => {
    const keyItem = ent("skel-key", "Skeleton Key", "item");
    const vm = mkVm({
      scope: [keyItem],
      inventory: { items: [], keys: [keyItem], equippedNames: [], slots: 6 },
    });
    const hotspots = sceneHotspots(vm);
    expect(hotspots.every((h) => h.key !== "skel-key")).toBe(true);
  });

  it("loot-content items are excluded from floor hotspots", () => {
    const contentItem = ent("candle-1", "Candle", "item");
    const loot: LootView = {
      id: "box-1",
      description: "a box",
      opened: false,
      contents: [contentItem],
    };
    // In the real viewmodel, loot contents appear in scope too.
    const vm = mkVm({ scope: [contentItem], loot: [loot] });
    const hotspots = sceneHotspots(vm);
    const floorHotspots = hotspots.filter((h) => h.kind === "item");
    expect(floorHotspots.every((h) => h.key !== "candle-1")).toBe(true);
  });

  it("contents of an OPENED container appear as floor-item hotspots", () => {
    const contentItem = ent("candle-1", "Candle", "item");
    const loot: LootView = { id: "box-1", description: "a box", opened: true, contents: [contentItem] };
    const vm = mkVm({ scope: [contentItem], loot: [loot] });
    const floorHotspots = sceneHotspots(vm).filter((h) => h.kind === "item");
    expect(floorHotspots.some((h) => h.key === "candle-1")).toBe(true);
  });

  it("floor item carries image when present", () => {
    const item = ent("torch-1", "Torch", "item", { image: "torch.png" });
    const vm = mkVm({ scope: [item] });
    const [h] = sceneHotspots(vm);
    expect(h!.image).toBe("torch.png");
  });
});

// ── inventoryActions ───────────────────────────────────────────────────────

describe("inventoryActions", () => {
  const sword = ent("sword-1", "Rusty Sword", "item");

  it("unequipped item → Examine, Equip, Use, Drop (in that order)", () => {
    const actions = inventoryActions(sword, false);
    expect(actions).toEqual([
      { label: "Examine", kind: "examine", targetId: "sword-1" },
      { label: "Equip", kind: "intent", intent: { kind: "equip", targetId: "sword-1" } },
      { label: "Use", kind: "intent", intent: { kind: "use", targetId: "sword-1" } },
      { label: "Drop", kind: "intent", intent: { kind: "drop", targetId: "sword-1" } },
    ]);
  });

  it("equipped item → Examine, Unequip, Use, Drop (in that order)", () => {
    const actions = inventoryActions(sword, true);
    expect(actions).toEqual([
      { label: "Examine", kind: "examine", targetId: "sword-1" },
      { label: "Unequip", kind: "intent", intent: { kind: "unequip", targetId: "sword-1" } },
      { label: "Use", kind: "intent", intent: { kind: "use", targetId: "sword-1" } },
      { label: "Drop", kind: "intent", intent: { kind: "drop", targetId: "sword-1" } },
    ]);
  });

  it("equipped:false → no Unequip; equipped:true → no Equip", () => {
    const unequipped = inventoryActions(sword, false);
    const equipped = inventoryActions(sword, true);
    expect(unequipped.some((a) => a.label === "Unequip")).toBe(false);
    expect(equipped.some((a) => a.label === "Equip")).toBe(false);
  });

  it("returns four actions in both equipped states", () => {
    expect(inventoryActions(sword, false)).toHaveLength(4);
    expect(inventoryActions(sword, true)).toHaveLength(4);
  });
});

// ── Winning-path verb coverage ─────────────────────────────────────────────

describe("winning-path verbs", () => {
  it("go (move intent) is emitted by exits", () => {
    const vm = mkVm({ exits: [{ dir: Directions.South, toName: "Cellar" }] });
    const [h] = sceneHotspots(vm);
    const action = h!.actions[0]!;
    expect(action.kind).toBe("intent");
    if (action.kind === "intent") {
      expect(action.intent.kind).toBe("move");
    }
  });

  it("attack intent is emitted for a living occupant", () => {
    const mob = ent("ghost-1", "Specter", "occupant");
    const vm = mkVm({ occupants: [mob] });
    const [h] = sceneHotspots(vm);
    const attackAction = h!.actions.find(
      (a): a is Extract<ActionDescriptor, { kind: "intent" }> =>
        a.kind === "intent" && a.intent.kind === "attack",
    );
    expect(attackAction).toBeDefined();
    expect(attackAction!.intent.kind).toBe("attack");
  });

  it("open intent is emitted by loot containers", () => {
    const loot: LootView = { id: "drawer-1", description: "a drawer", opened: false, contents: [] };
    const vm = mkVm({ loot: [loot] });
    const [h] = sceneHotspots(vm);
    const openAction = h!.actions.find(
      (a): a is Extract<ActionDescriptor, { kind: "intent" }> =>
        a.kind === "intent" && a.intent.kind === "open",
    );
    expect(openAction).toBeDefined();
    expect(openAction!.intent.kind).toBe("open");
  });

  it("take intent is emitted by floor items", () => {
    const item = ent("note-1", "Torn Note", "item");
    const vm = mkVm({ scope: [item] });
    const [h] = sceneHotspots(vm);
    const takeAction = h!.actions.find(
      (a): a is Extract<ActionDescriptor, { kind: "intent" }> =>
        a.kind === "intent" && a.intent.kind === "take",
    );
    expect(takeAction).toBeDefined();
    expect(takeAction!.intent.kind).toBe("take");
  });

  it("equip intent is emitted by inventoryActions for unequipped items", () => {
    const staff = ent("staff-1", "Oaken Staff", "item");
    const actions = inventoryActions(staff, false);
    const equipAction = actions.find(
      (a): a is Extract<ActionDescriptor, { kind: "intent" }> =>
        a.kind === "intent" && a.intent.kind === "equip",
    );
    expect(equipAction).toBeDefined();
    expect(equipAction!.intent.kind).toBe("equip");
  });

  it("examine is routed as kind:examine (not an intent) for scene entities", () => {
    const mob = ent("beast-1", "Beast", "occupant");
    const vm = mkVm({ occupants: [mob] });
    const [h] = sceneHotspots(vm);
    const examineAction = h!.actions.find((a) => a.label === "Examine");
    expect(examineAction).toBeDefined();
    expect(examineAction!.kind).toBe("examine");
    if (examineAction && examineAction.kind === "examine") {
      expect(examineAction.targetId).toBe("beast-1");
    }
  });

  it("examine is routed as kind:examine in inventoryActions", () => {
    const item = ent("ring-1", "Tarnished Ring", "item");
    const actions = inventoryActions(item, false);
    const examineAction = actions[0]!;
    expect(examineAction.kind).toBe("examine");
    if (examineAction.kind === "examine") {
      expect(examineAction.targetId).toBe("ring-1");
    }
  });
});

// ── Mixed scene ────────────────────────────────────────────────────────────

describe("sceneHotspots — mixed scene", () => {
  it("emits hotspots in order: exits, locked, occupants, loot, floor items", () => {
    const occupant = ent("mob-1", "Zombie", "occupant");
    const floorItem = ent("bone-1", "Bone", "item");
    const loot: LootView = { id: "crate-1", description: "a crate", opened: false, contents: [] };
    const vm = mkVm({
      exits: [{ dir: Directions.North, toName: "Hall" }],
      lockedDoors: [{ name: "Rusted Door", dir: Directions.South }],
      occupants: [occupant],
      loot: [loot],
      scope: [occupant, floorItem, ...loot.contents],
    });
    const kinds = sceneHotspots(vm).map((h) => h.kind);
    expect(kinds).toEqual(["exit", "locked", "occupant", "loot", "item"]);
  });
});
