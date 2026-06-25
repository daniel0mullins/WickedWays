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

