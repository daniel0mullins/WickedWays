import { describe, it, expect } from "vitest";
import { MapModel } from "./map-model.js";
import type { ViewModel } from "./viewmodel.js";

// Minimal viewmodel stub — only the fields MapModel reads.
function view(over: {
  id: string; name: string;
  exits?: { dir: string }[]; locked?: { dir: string }[]; remains?: boolean;
}): ViewModel {
  return {
    room: { id: over.id, name: over.name, description: "", isLit: true },
    exits: (over.exits ?? []).map((e) => ({ dir: e.dir, toName: "?" })),
    lockedDoors: (over.locked ?? []).map((d) => ({ dir: d.dir, name: "door" })),
    occupants: over.remains ? [{ id: "m", name: "Wraith", aliases: [], kind: "occupant", defeated: true }] : [],
    loot: [], inventory: { items: [], keys: [], equippedNames: [] }, scope: [],
    status: { locationName: over.name, turn: 1, maxTurns: 30, sanity: 10, health: 10 },
    outcome: "ongoing", finished: false,
  } as unknown as ViewModel;
}

describe("MapModel", () => {
  it("seeds the first observed room at the origin with its stubs", () => {
    const m = new MapModel();
    m.observe(view({ id: "foyer", name: "Foyer", exits: [{ dir: "north" }], locked: [{ dir: "south" }] }));
    expect(m.rooms()).toEqual([{ id: "foyer", name: "Foyer", x: 0, y: 0, hasRemains: false }]);
    expect(m.currentId).toBe("foyer");
    expect(m.stubsFor("foyer")).toEqual([
      { dir: "north", locked: false },
      { dir: "south", locked: true },
    ]);
  });

  it("places a moved-to room by direction delta and records the edge", () => {
    const m = new MapModel();
    m.observe(view({ id: "foyer", name: "Foyer", exits: [{ dir: "north" }] }));
    m.recordMove("foyer", "north", "hall");
    m.observe(view({ id: "hall", name: "Hall", exits: [{ dir: "east" }, { dir: "south" }] }));
    const hall = m.rooms().find((r) => r.id === "hall");
    expect(hall).toMatchObject({ id: "hall", name: "Hall", x: 0, y: -1 });
    expect(m.edges()).toEqual([{ a: "foyer", b: "hall", dir: "north", locked: false }]);
    // Foyer's north stub is consumed; Hall's south (back to Foyer) is NOT a stub.
    expect(m.stubsFor("foyer")).toEqual([]);
    expect(m.stubsFor("hall")).toEqual([{ dir: "east", locked: false }]);
  });

  it("combines deltas for diagonals", () => {
    const m = new MapModel();
    m.observe(view({ id: "a", name: "A", exits: [{ dir: "northeast" }] }));
    m.recordMove("a", "northeast", "b");
    m.observe(view({ id: "b", name: "B" }));
    expect(m.rooms().find((r) => r.id === "b")).toMatchObject({ x: 1, y: -1 });
  });

  it("keeps the first coordinate on a conflicting second path (first-placement wins)", () => {
    const m = new MapModel();
    m.observe(view({ id: "a", name: "A" }));
    m.recordMove("a", "north", "b");      // b at (0,-1)
    m.recordMove("a", "east", "b");       // conflicting; b stays at (0,-1)
    expect(m.rooms().find((r) => r.id === "b")).toMatchObject({ x: 0, y: -1 });
  });

  it("tracks mob remains per room from the last observation", () => {
    const m = new MapModel();
    m.observe(view({ id: "nursery", name: "Nursery", remains: true }));
    expect(m.rooms()[0]!.hasRemains).toBe(true);
    m.observe(view({ id: "nursery", name: "Nursery", remains: false }));
    expect(m.rooms()[0]!.hasRemains).toBe(false);
  });

  it("round-trips through serialize/hydrate and clears on reset", () => {
    const m = new MapModel();
    m.observe(view({ id: "foyer", name: "Foyer", exits: [{ dir: "north" }] }));
    m.recordMove("foyer", "north", "hall");
    m.observe(view({ id: "hall", name: "Hall", remains: true }));
    const snap = m.serialize();

    const restored = new MapModel();
    restored.hydrate(snap);
    expect(restored.serialize()).toEqual(snap);
    expect(restored.currentId).toBe("hall");

    restored.reset();
    expect(restored.rooms()).toEqual([]);
    expect(restored.currentId).toBeNull();
  });
});
