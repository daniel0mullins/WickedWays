import { describe, it, expect } from "vitest";
import { Narrator } from "./narrator.js";
import { Directions } from "wickedways/lib/room";
import type { ViewModel } from "../core/viewmodel.js";
import type { PresentationCue } from "wickedways/lib/presentation";

const vm = (over: Partial<ViewModel> = {}): ViewModel => ({
  room: { id: "hall", name: "Hall", description: "A long central hall.", isLit: true },
  exits: [{ dir: Directions.North, toName: "Landing" }],
  lockedDoors: [], occupants: [], loot: [],
  inventory: { items: [], keys: [], equippedNames: [] }, scope: [],
  status: { locationName: "Hall", turn: 1, maxTurns: 150, sanity: 10, health: 10 },
  outcome: "ongoing", finished: false, ...over,
});

describe("Narrator.renderRoom", () => {
  it("gives the full description first, terse on return", () => {
    const n = new Narrator();
    const first = n.renderRoom(vm()).join("\n");
    expect(first).toContain("A long central hall.");
    const second = n.renderRoom(vm()).join("\n");
    expect(second).not.toContain("A long central hall.");
    expect(second).toContain("Hall");
  });
});

describe("Narrator.renderRoomParts", () => {
  it("header is the bare room name (no asterisks)", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm());
    expect(parts.header).toBe("Hall");
    expect(parts.header).not.toContain("*");
  });

  it("description is present on first visit", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm());
    expect(parts.description).toBe("A long central hall.");
  });

  it("description is null on re-entry", () => {
    const n = new Narrator();
    n.renderRoomParts(vm()); // first visit
    const second = n.renderRoomParts(vm());
    expect(second.description).toBeNull();
  });

  it("header still present on re-entry", () => {
    const n = new Narrator();
    n.renderRoomParts(vm()); // first visit
    const second = n.renderRoomParts(vm());
    expect(second.header).toBe("Hall");
  });

  it("body contains exits", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm());
    expect(parts.body.join("\n")).toContain("Exits:");
    expect(parts.body.join("\n")).toContain("north");
  });

  it("body contains occupants when present", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm({
      occupants: [{ id: "ghost", name: "ghost", aliases: [], kind: "occupant" as const }],
    }));
    expect(parts.body.join("\n")).toContain("You see ghost.");
  });

  it("description is null on first visit when dark (dark returns body-only)", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm({ room: { id: "cellar", name: "Cellar", description: "A dank cellar.", isLit: false } }));
    // Description is still returned on first visit even when dark — dark message goes in body
    expect(parts.description).toBe("A dank cellar.");
    expect(parts.body).toContain("It is pitch dark. You can see nothing.");
  });

  it("renderRoom and renderRoomParts produce the same flat lines", () => {
    // Use a fresh narrator for each so visited state is clean
    const n1 = new Narrator();
    const n2 = new Narrator();
    const flat = n1.renderRoom(vm());
    const parts = n2.renderRoomParts(vm());
    const fromParts = [parts.header, ...(parts.description ? [parts.description] : []), ...parts.body];
    expect(flat).toEqual(fromParts);
  });
});

describe("Narrator.renderCues", () => {
  it("passes mechanic cue text through verbatim", () => {
    const n = new Narrator();
    const cues: PresentationCue[] = [{ kind: "mechanic", cue: { text: "The cellar reeks of old water." } }];
    expect(n.renderCues(cues)).toContain("The cellar reeks of old water.");
  });
  it("renders a resolution cue as the closing line", () => {
    const n = new Narrator();
    const cues: PresentationCue[] = [{ kind: "resolution", outcome: "won", narration: { text: "You may leave." } }];
    expect(n.renderCues(cues).join("\n")).toContain("You may leave.");
  });
});
