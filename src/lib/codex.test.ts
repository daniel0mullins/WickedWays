import { describe, expect, it } from "vitest";

import { Codex, type CodexFirstSeen } from "./codex";
import type { ICharacter, CharacterId } from "./character/character";
import type { IItem } from "./inventory";
import type { IRoom, RoomId } from "./room";
import type { CraftingRecipe, RecipeId } from "./crafting";

const seen = (over: Partial<CodexFirstSeen> = {}): CodexFirstSeen => ({
  round: 0,
  characterId: "c1" as CharacterId,
  roomId: "r1" as RoomId,
  ...over,
});

const mobEvent = (name = "Goblin") =>
  ({
    kind: "mob" as const,
    mob: {
      name,
      stats: { health: 5, sanity: 3, energy: 4 },
      presentation: { image: "goblin.png" },
    } as unknown as ICharacter,
  });

const weaponEvent = () =>
  ({
    kind: "item" as const,
    item: { name: "Sword", type: "weapon", slot: "hand", twoHanded: false } as unknown as IItem,
  });

const keyEvent = () =>
  ({
    kind: "item" as const,
    item: { name: "Gold Key", type: "key", keyCode: "throne", consumeOnUse: true } as unknown as IItem,
  });

const roomEvent = () =>
  ({ kind: "room" as const, room: { id: "r1", name: "Crypt", description: "cold" } as unknown as IRoom });

const recipeEvent = () =>
  ({
    kind: "recipe" as const,
    recipe: {
      id: "iron-sword" as RecipeId,
      materials: { metal: 2 },
      create: () => ({ name: "Iron Sword" }) as unknown as IItem,
    } as unknown as CraftingRecipe,
  });

describe("Codex", () => {
  it("records a mob and exposes a frozen snapshot with full stats", () => {
    const codex = new Codex();
    codex.record(mobEvent(), seen());

    expect(codex.size).toBe(1);
    const entry = codex.mobs[0]!;
    expect(entry.kind).toBe("mob");
    expect(entry.snapshot).toEqual({
      name: "Goblin",
      stats: { health: 5, sanity: 3, energy: 4 },
      presentation: { image: "goblin.png" },
    });
    expect(entry.firstSeen).toEqual({ round: 0, characterId: "c1", roomId: "r1" });
    expect(() => {
      (entry.snapshot as unknown as { name: string }).name = "x";
    }).toThrow();
  });

  it("is first-write-wins: a repeat encounter keeps the original firstSeen", () => {
    const codex = new Codex();
    codex.record(mobEvent(), seen({ round: 1, characterId: "a" as CharacterId }));
    codex.record(mobEvent(), seen({ round: 7, characterId: "b" as CharacterId }));

    expect(codex.size).toBe(1);
    expect(codex.mobs[0]!.firstSeen.round).toBe(1);
    expect(codex.mobs[0]!.firstSeen.characterId).toBe("a");
  });

  it("separates keys from items by kind", () => {
    const codex = new Codex();
    codex.record(weaponEvent(), seen());
    codex.record(keyEvent(), seen());

    expect(codex.items.map((e) => e.snapshot.name)).toEqual(["Sword"]);
    expect(codex.keys.map((e) => e.snapshot.name)).toEqual(["Gold Key"]);
    expect(codex.keys[0]!.snapshot).toEqual({ name: "Gold Key", keyCode: "throne", consumeOnUse: true });
  });

  it("snapshots a room and a recipe (output name from create())", () => {
    const codex = new Codex();
    codex.record(roomEvent(), seen());
    codex.record(recipeEvent(), seen({ roomId: undefined }));

    expect(codex.rooms[0]!.snapshot).toEqual({ name: "Crypt", description: "cold" });
    expect(codex.recipes[0]!.snapshot).toEqual({
      id: "iron-sword",
      materials: { metal: 2 },
      outputName: "Iron Sword",
    });
  });

  it("records a material kind and supports get()/all", () => {
    const codex = new Codex();
    codex.record({ kind: "material", material: "metal" }, seen());

    expect(codex.materials[0]!.snapshot).toEqual({ type: "metal" });
    expect(codex.get("material", "metal")?.snapshot).toEqual({ type: "metal" });
    expect(codex.get("material", "glass")).toBeUndefined();
    expect(codex.all).toHaveLength(1);
  });

  it("decouples the snapshot from the live entity (mutating the source after record)", () => {
    const codex = new Codex();
    const event = mobEvent();
    codex.record(event, seen());
    (event.mob.presentation as { image?: string }).image = "changed.png";

    expect(codex.mobs[0]!.snapshot.presentation).toEqual({ image: "goblin.png" });
  });

  it("sorts each kind by display name", () => {
    const codex = new Codex();
    codex.record(mobEvent("Zombie"), seen());
    codex.record(mobEvent("Bat"), seen());

    expect(codex.mobs.map((e) => e.snapshot.name)).toEqual(["Bat", "Zombie"]);
  });
});
