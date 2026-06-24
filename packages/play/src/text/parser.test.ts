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

describe("parser — doors", () => {
  it("unlock targets a locked door; open on a door is a synonym for unlock", () => {
    const door = ent("study-door", "study door", ["study door", "door"], "door");
    const v = vm({ scope: [door], lockedDoors: [{ id: "study-door", name: "study door", dir: Directions.West }] });
    expect(parse("unlock study door", v)).toEqual({ kind: "intent", intent: { kind: "unlock", doorId: "study-door" } });
    expect(parse("open door", v)).toEqual({ kind: "intent", intent: { kind: "unlock", doorId: "study-door" } });
  });
  it("open on a loot box is an open intent", () => {
    const box = ent("b1", "a chest", ["chest", "box"], "loot");
    expect(parse("open chest", vm({ scope: [box] }))).toEqual({ kind: "intent", intent: { kind: "open", targetId: "b1" } });
  });
});
