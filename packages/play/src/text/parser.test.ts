import { describe, it, expect } from "vitest";
import { parse } from "./parser.js";
import { Directions } from "wickedways/lib/room";
import type { ViewModel, ScopeEntity } from "../core/viewmodel.js";

const ent = (id: string, name: string, aliases: string[], kind: ScopeEntity["kind"]): ScopeEntity => ({ id, name, aliases, kind });
const vm = (over: Partial<ViewModel> = {}): ViewModel => ({
  room: { id: "r", name: "Hall", description: "a hall", isLit: true },
  exits: [{ dir: Directions.North, toName: "Landing" }],
  lockedDoors: [],
  occupants: [],
  loot: [],
  inventory: { items: [], keys: [], equippedNames: [] },
  scope: [],
  status: { locationName: "Hall", turn: 1, maxTurns: 150, sanity: 10, health: 10 },
  outcome: "ongoing",
  finished: false,
  ...over,
});

describe("parser — movement", () => {
  it("maps directions and abbreviations to a move intent", () => {
    expect(parse("north", vm())).toEqual({ kind: "intent", intent: { kind: "move", dir: Directions.North } });
    expect(parse("n", vm())).toEqual({ kind: "intent", intent: { kind: "move", dir: Directions.North } });
    expect(parse("go north", vm())).toEqual({ kind: "intent", intent: { kind: "move", dir: Directions.North } });
  });
});

describe("parser — meta and queries", () => {
  it("recognizes look/inventory/exits/help and save/restore/undo", () => {
    expect(parse("look", vm())).toEqual({ kind: "query", query: "look" });
    expect(parse("i", vm())).toEqual({ kind: "query", query: "inventory" });
    expect(parse("save", vm())).toEqual({ kind: "meta", meta: "save" });
    expect(parse("undo", vm())).toEqual({ kind: "meta", meta: "undo" });
    expect(parse("restart", vm())).toEqual({ kind: "meta", meta: "restart" });
    expect(parse("fullscreen", vm())).toEqual({ kind: "meta", meta: "fullscreen" });
    expect(parse("fs", vm())).toEqual({ kind: "meta", meta: "fullscreen" });
    expect(parse("audio", vm())).toEqual({ kind: "meta", meta: "audio" });
    expect(parse("mute", vm())).toEqual({ kind: "meta", meta: "audio" });
  });
});

describe("parser — noun resolution", () => {
  const key = ent("k1", "Brass Key", ["brass key", "brass", "key"], "item");
  it("strips articles and resolves a take by alias", () => {
    const v = vm({ scope: [key] });
    expect(parse("take the brass key", v)).toEqual({ kind: "intent", intent: { kind: "take", targetId: "k1" } });
  });
  it("returns an error when the noun is not in scope", () => {
    expect(parse("take lantern", vm()).kind).toBe("error");
  });
  it("disambiguates when an alias matches more than one entity", () => {
    const iron = ent("k2", "Iron Key", ["iron key", "iron", "key"], "item");
    const res = parse("take key", vm({ scope: [key, iron] }));
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.candidates.map((c) => c.id).sort()).toEqual(["k1", "k2"]);
  });
});

describe("parser — read", () => {
  const journal = ent("j1", "Water-Stained Journal", ["journal", "diary", "book"], "item");
  it("treats `read <thing>` as examine", () => {
    const res = parse("read journal", vm({ scope: [journal] }));
    expect(res).toEqual({ kind: "examine", target: journal });
  });
});

describe("parser — open", () => {
  it("open on a loot box is an open intent", () => {
    const box = ent("b1", "a chest", ["chest", "box"], "loot");
    expect(parse("open chest", vm({ scope: [box] }))).toEqual({ kind: "intent", intent: { kind: "open", targetId: "b1" } });
  });
  it("open on a non-loot item is an error", () => {
    const item = ent("i1", "key", ["key"], "item");
    const res = parse("open key", vm({ scope: [item] }));
    expect(res.kind).toBe("error");
  });
});

describe("parser — direct take (item alias beats container description)", () => {
  const lantern = ent("item-lantern", "Brass Lantern", ["lantern", "lamp", "light"], "item");
  const hook = ent("box-hook", "A lantern hangs from a hook.", ["hook", "container"], "loot");

  it("take lantern resolves to take intent for the item (exact alias wins over container partial)", () => {
    const res = parse("take lantern", vm({ scope: [lantern, hook] }));
    expect(res).toEqual({ kind: "intent", intent: { kind: "take", targetId: "item-lantern" } });
  });

  it("take <container-alias> still returns the can't-carry error", () => {
    const drawer = ent("box-drawer", "a table drawer", ["drawer", "table", "container"], "loot");
    const res = parse("take drawer", vm({ scope: [drawer] }));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toContain("try taking what's inside it");
    }
  });
});
