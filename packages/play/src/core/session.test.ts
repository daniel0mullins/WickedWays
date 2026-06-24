import { describe, it, expect } from "vitest";
import { GameSession } from "./session.js";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, LOCKED_DOORS, ALIASES } from "../campaign/index.js";
import { LocalStorageSaveStore } from "./savestore.js";
import { Rooms, Archetypes } from "../campaign/ids.js";
import { Directions } from "wickedways/lib/room";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

function newSession() {
  return GameSession.start({
    builder: hauntedHouseTemplate(),
    registry: buildHauntedHouseRegistry(),
    doors: LOCKED_DOORS,
    aliases: ALIASES,
    playerName: "Heir",
    archetype: Archetypes.Heir,
    saveStore: new LocalStorageSaveStore(new MemStorage() as unknown as Storage),
    now: () => 1234,
    rng: () => 0.5,
  });
}

describe("GameSession", () => {
  it("starts the player in the Foyer", () => {
    expect(newSession().view().room.name).toBe(Rooms.Foyer);
  });
  it("a move advances the round; an open does not", () => {
    const s = newSession();
    const before = s.view().status.turn;
    s.execute({ kind: "move", dir: Directions.North });
    expect(s.view().room.name).toBe(Rooms.Hall);
    expect(s.view().status.turn).toBe(before + 1);
    const afterMove = s.view().status.turn;
    const box = s.view().loot[0]!;
    s.execute({ kind: "open", targetId: box.id });
    expect(s.view().status.turn).toBe(afterMove); // open is free
    expect(s.view().loot[0]!.opened).toBe(true);
  });
  // Helpers for the unlock success path. (The brass key is a Wraith drop — keys
  // cannot be authored into loot — so the only legitimate route is through combat.)
  const openTake = (s: GameSession, name: string): void => {
    const box = s.view().loot.find((l) => l.contents.some((c) => c.name === name))!;
    s.execute({ kind: "open", targetId: box.id });
    const item = s.view().scope.find((e) => e.name === name)!;
    s.execute({ kind: "take", targetId: item.id });
  };
  const equipNamed = (s: GameSession, name: string): void => {
    const item = s.view().inventory.items.find((i) => i.name === name)!;
    s.execute({ kind: "equip", targetId: item.id });
  };

  it("unlock fails in-voice without the matching key, and reveals nothing", () => {
    const s = newSession();
    s.execute({ kind: "move", dir: Directions.North });   // Hall
    s.execute({ kind: "move", dir: Directions.North });   // Landing
    const door = s.view().lockedDoors.find((d) => d.id === "study-door")!;
    const res = s.execute({ kind: "unlock", doorId: door.id });
    expect(res.error).toBeTruthy();
    expect(s.view().exits.map((e) => e.toName)).not.toContain(Rooms.Study);
  });

  it("unlock reveals the study door once the brass key (a Wraith drop) is in hand", () => {
    const s = newSession();
    // Mirror the proven winning sequence: equip poker + lantern (the lantern is
    // required to fight in the dark Nursery), then fell the Wraith for the brass key.
    s.execute({ kind: "move", dir: Directions.North });   // Hall
    openTake(s, "Iron Fire-Poker"); equipNamed(s, "Iron Fire-Poker");
    s.execute({ kind: "move", dir: Directions.West });    // Kitchen
    openTake(s, "Brass Lantern"); equipNamed(s, "Brass Lantern");
    s.execute({ kind: "move", dir: Directions.East });    // Hall
    s.execute({ kind: "move", dir: Directions.North });   // Landing
    s.execute({ kind: "move", dir: Directions.East });    // Nursery
    const wraith = s.view().occupants.find((o) => o.name === "Wraith")!;
    for (let i = 0; i < 10; i++) s.execute({ kind: "attack", targetId: wraith.id }); // KO'd early; later attacks no-op via caught error
    openTake(s, "Brass Key");                              // dropped into the Nursery on defeat
    s.execute({ kind: "move", dir: Directions.West });    // Landing
    const door = s.view().lockedDoors.find((d) => d.id === "study-door")!;
    s.execute({ kind: "unlock", doorId: door.id });
    expect(s.view().exits.map((e) => e.toName)).toContain(Rooms.Study);
  });
  it("save then restore reproduces location and inventory", async () => {
    const s = newSession();
    s.execute({ kind: "move", dir: Directions.North });
    await s.save("slot1");
    s.execute({ kind: "move", dir: Directions.West });    // Kitchen
    expect(s.view().room.name).toBe(Rooms.Kitchen);
    expect(await s.restore("slot1")).toBe(true);
    expect(s.view().room.name).toBe(Rooms.Hall);
  });
  it("undo reverts the last time-advancing command", () => {
    const s = newSession();
    s.execute({ kind: "move", dir: Directions.North });
    expect(s.view().room.name).toBe(Rooms.Hall);
    expect(s.undo()).toBe(true);
    expect(s.view().room.name).toBe(Rooms.Foyer);
  });
});
