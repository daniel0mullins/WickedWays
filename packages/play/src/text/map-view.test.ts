import { describe, it, expect } from "vitest";
import { MapModel } from "../core/map-model.js";
import type { ViewModel } from "../core/viewmodel.js";
import { layoutMap } from "./map-view.js";

function view(over: { id: string; name: string; exits?: { dir: string }[]; locked?: { dir: string }[]; remains?: boolean }): ViewModel {
  return {
    room: { id: over.id, name: over.name, description: "", isLit: true },
    exits: (over.exits ?? []).map((e) => ({ dir: e.dir, toName: "?" })),
    lockedDoors: (over.locked ?? []).map((d) => ({ dir: d.dir, name: "door" })),
    occupants: over.remains ? [{ id: "m", name: "M", aliases: [], kind: "occupant", defeated: true }] : [],
    loot: [], inventory: { items: [], keys: [], equippedNames: [] }, scope: [],
    status: { locationName: over.name, turn: 1, maxTurns: 30, sanity: 10, health: 10 },
    outcome: "ongoing", finished: false,
  } as unknown as ViewModel;
}

describe("layoutMap", () => {
  it("places boxes by grid coord, normalizing to a positive origin", () => {
    const m = new MapModel();
    m.observe(view({ id: "foyer", name: "Foyer", exits: [{ dir: "north" }] }));
    m.recordMove("foyer", "north", "hall");
    m.observe(view({ id: "hall", name: "Hall", remains: true, locked: [{ dir: "east" }] }));
    const lay = layoutMap(m);

    const foyer = lay.boxes.find((b) => b.label === "Foyer")!;
    const hall = lay.boxes.find((b) => b.label === "Hall")!;
    // Hall is north of Foyer → smaller y; both shifted so the top-left is at PAD.
    expect(hall.y).toBeLessThan(foyer.y);
    expect(Math.min(foyer.x, hall.x)).toBe(30);     // PAD
    expect(Math.min(foyer.y, hall.y)).toBe(30);     // PAD
    // Current room + remains flags surface on the boxes.
    expect(hall.current).toBe(true);
    expect(hall.remains).toBe(true);
    expect(foyer.current).toBe(false);
  });

  it("emits a link for the traversed edge and a stub for the unexplored exit", () => {
    const m = new MapModel();
    m.observe(view({ id: "foyer", name: "Foyer", exits: [{ dir: "north" }] }));
    m.recordMove("foyer", "north", "hall");
    m.observe(view({ id: "hall", name: "Hall", locked: [{ dir: "east" }] }));
    const lay = layoutMap(m);

    expect(lay.links).toHaveLength(1);
    expect(lay.links[0]!.locked).toBe(false);
    expect(lay.stubs).toHaveLength(1);
    expect(lay.stubs[0]!.locked).toBe(true);        // Hall's east door is locked
    expect(lay.width).toBeGreaterThan(0);
    expect(lay.height).toBeGreaterThan(0);
  });

  it("handles an empty model", () => {
    const lay = layoutMap(new MapModel());
    expect(lay.boxes).toEqual([]);
    expect(lay.width).toBeGreaterThan(0);
  });
});
