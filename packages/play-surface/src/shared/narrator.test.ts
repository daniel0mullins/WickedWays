import { describe, it, expect } from "vitest";
import { Narrator } from "./narrator.js";
import { Directions } from "wickedways/lib/room";
import { StatType } from "wickedways/lib/character/stats";
import type { ViewModel } from "@wickedways/play-runtime";
import type { PresentationCue } from "wickedways/lib/presentation";

const vm = (over: Partial<ViewModel> = {}): ViewModel => ({
  room: { id: "hall", name: "Hall", description: "A long central hall.", isLit: true },
  exits: [{ dir: Directions.North, toName: "Landing" }],
  lockedDoors: [], occupants: [], loot: [],
  inventory: { items: [], keys: [], equippedNames: [], slots: 0 }, scope: [],
  status: { locationName: "Hall", turn: 1, maxTurns: 150, sanity: 10, health: 10 },
  outcome: "ongoing", finished: false, ...over,
});

describe("Narrator.renderRoom", () => {
  it("gives the full description on every visit", () => {
    const n = new Narrator();
    const first = n.renderRoom(vm()).join("\n");
    expect(first).toContain("A long central hall.");
    const second = n.renderRoom(vm()).join("\n");
    expect(second).toContain("A long central hall.");
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

  it("description is present on re-entry", () => {
    const n = new Narrator();
    n.renderRoomParts(vm()); // first visit
    const second = n.renderRoomParts(vm());
    expect(second.description).toBe("A long central hall.");
  });

  it("header still present on re-entry", () => {
    const n = new Narrator();
    n.renderRoomParts(vm()); // first visit
    const second = n.renderRoomParts(vm());
    expect(second.header).toBe("Hall");
  });

  it("body omits the Exits: line (moved to the bottom HUD)", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm());
    expect(parts.body.join("\n")).not.toContain("Exits:");
  });

  it("body omits the Here: loot line (moved to the bottom HUD)", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm({
      loot: [{ id: "table", description: "A hall table", opened: false, contents: [] }],
    }));
    expect(parts.body.join("\n")).not.toContain("Here:");
    expect(parts.body.join("\n")).not.toContain("A hall table");
  });

  it("body contains occupants when present", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm({
      occupants: [{ id: "ghost", name: "ghost", aliases: [], kind: "occupant" as const }],
    }));
    expect(parts.body.join("\n")).toContain("You see ghost.");
  });

  it("body omits defeated occupants from 'You see'", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm({
      occupants: [
        { id: "ghost", name: "ghost", aliases: [], kind: "occupant" as const },
        { id: "corpse", name: "Wraith", aliases: [], kind: "occupant" as const, defeated: true },
      ],
    }));
    expect(parts.body.join("\n")).toContain("You see ghost.");
    expect(parts.body.join("\n")).not.toContain("Wraith");
  });

  it("returns the description even when dark (dark message goes in body)", () => {
    const n = new Narrator();
    const parts = n.renderRoomParts(vm({ room: { id: "cellar", name: "Cellar", description: "A dank cellar.", isLit: false } }));
    expect(parts.description).toBe("A dank cellar.");
    expect(parts.body).toContain("It is pitch dark. You can see nothing.");
  });

  it("renderRoom and renderRoomParts produce the same flat lines", () => {
    const n1 = new Narrator();
    const n2 = new Narrator();
    const flat = n1.renderRoom(vm());
    const parts = n2.renderRoomParts(vm());
    const fromParts = [parts.header, ...(parts.description ? [parts.description] : []), ...parts.body];
    expect(flat).toEqual(fromParts);
  });
});

describe("Narrator.renderAction", () => {
  const journal = { id: "journal", name: "Water-Stained Journal", aliases: ["journal"], kind: "item" as const };

  it("confirms a take with the item's name", () => {
    const n = new Narrator();
    const before = vm({ scope: [journal] });          // journal is in the room as loot content
    const after = vm({ scope: [journal], inventory: { items: [journal], keys: [], equippedNames: [], slots: 6 } });
    expect(n.renderAction({ kind: "take", targetId: "journal" }, before, after).join(" ")).toContain("Water-Stained Journal");
  });

  it("confirms a drop with the item's name", () => {
    const n = new Narrator();
    const before = vm({ scope: [journal], inventory: { items: [journal], keys: [], equippedNames: [], slots: 6 } });
    const after = vm();                               // gone from inventory after drop
    const line = n.renderAction({ kind: "drop", targetId: "journal" }, before, after).join(" ");
    expect(line).toContain("Water-Stained Journal");
  });

  it("describes opening a container by listing its contents", () => {
    const n = new Narrator();
    const loot = { id: "drawer", description: "A hall table with a single drawer.", opened: true, contents: [journal] };
    const before = vm({ loot: [loot], scope: [journal] });
    const line = n.renderAction({ kind: "open", targetId: "drawer" }, before, before).join(" ");
    expect(line).toContain("Water-Stained Journal");
  });

  it("names the item on unequip via the after-view (item returns to inventory)", () => {
    const n = new Narrator();
    const before = vm();                              // equipped item not in scope
    const after = vm({ scope: [journal], inventory: { items: [journal], keys: [], equippedNames: [], slots: 6 } });
    expect(n.renderAction({ kind: "unequip", targetId: "journal" }, before, after).join(" ")).toContain("Water-Stained Journal");
  });

  it("returns no synthetic line for move (the room re-render speaks for it)", () => {
    const n = new Narrator();
    expect(n.renderAction({ kind: "move", dir: Directions.North }, vm(), vm())).toEqual([]);
  });

  const foe = (id: string, name: string, health: number, defeated = false) =>
    ({ id, name, aliases: [name.toLowerCase()], kind: "occupant" as const, health, defeated });

  it("reports how much damage an attack dealt", () => {
    const n = new Narrator();
    const before = vm({ occupants: [foe("w", "Wraith", 6)] });
    const after = vm({ occupants: [foe("w", "Wraith", 4)] });
    expect(n.renderAction({ kind: "attack", targetId: "w" }, before, after).join(" ")).toContain("for 2");
  });

  it("announces a defeat on the killing blow", () => {
    const n = new Narrator();
    const before = vm({ occupants: [foe("w", "Wraith", 1)] });
    const after = vm({ occupants: [foe("w", "Wraith", 0, true)] });
    expect(n.renderAction({ kind: "attack", targetId: "w" }, before, after).join(" ").toLowerCase()).toContain("down");
  });

  it("notes a glancing blow when no damage lands", () => {
    const n = new Narrator();
    const before = vm({ occupants: [foe("w", "Wraith", 6)] });
    const after = vm({ occupants: [foe("w", "Wraith", 6)] });
    expect(n.renderAction({ kind: "attack", targetId: "w" }, before, after).join(" ").toLowerCase()).toContain("glance");
  });
});

describe("Narrator.renderExamine", () => {
  it("phrases a loot container without a doubled article or period", () => {
    const n = new Narrator();
    const loot = { id: "table", name: "A hall table with a single drawer.", aliases: ["drawer"], kind: "loot" as const };
    const line = n.renderExamine(loot, vm()).join(" ");
    expect(line).not.toContain("the A ");
    expect(line).not.toContain("..");
    expect(line).toContain("the hall table with a single drawer.");
  });

  it("leaves a plain item name untouched", () => {
    const n = new Narrator();
    const item = { id: "j", name: "Water-Stained Journal", aliases: [], kind: "item" as const };
    expect(n.renderExamine(item, vm()).join(" ")).toContain("the Water-Stained Journal.");
  });
});

describe("Narrator.renderMobAttacks", () => {
  it("names the stat lost, with stat-specific flavor", () => {
    const n = new Narrator();
    const lines = n.renderMobAttacks([
      { name: "Wraith", stat: StatType.Sanity, amount: 3 },
      { name: "Revenant", stat: StatType.Health, amount: 2 },
    ]);
    expect(lines[0]).toContain("Wraith");
    expect(lines[0]).toContain("3 Sanity");
    expect(lines[0]!.toLowerCase()).toContain("mind");
    expect(lines[1]).toContain("2 Health");
  });

  it("renders nothing for no attacks", () => {
    expect(new Narrator().renderMobAttacks([])).toEqual([]);
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
