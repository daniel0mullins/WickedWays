import { describe, expect, it, vi } from "vitest";

import type { CharacterId, ICharacter } from "./character/character";
import type { ILoot, LootId } from "./loot";
import { MaterialCache } from "./material-cache";
import { Room } from "./room";
import type { IScene, Scene } from "./scene";
import { ProceduralViolation } from "./util";

import { type ExitsArg } from "../test-utils";

// `Room` only ever touches an occupant's `id`, a loot batch's `id`, and a
// scene's `playScene`, so minimal stubs cast to the interfaces are enough.
let idCounter = 0;
function makeCharacter(id: CharacterId = `char-${++idCounter}` as CharacterId): ICharacter {
  return { id } as unknown as ICharacter;
}

function makeLoot(id: LootId = `loot-${++idCounter}` as LootId): ILoot {
  return { id } as unknown as ILoot;
}

function makeScene(): IScene & { playScene: ReturnType<typeof vi.fn> } {
  return { id: "scene-1", preconditions: [], playScene: vi.fn() } as unknown as IScene & {
    playScene: ReturnType<typeof vi.fn>;
  };
}

function makeRoom(loot: ILoot[] = [], exits: Partial<ExitsArg> = {}): Room {
  return new Room("A Dim Room", "a dim room", loot, exits as ExitsArg);
}

describe("Room", () => {
  describe("constructor", () => {
    it("assigns an id and the description", () => {
      const room = makeRoom();

      expect(typeof room.id).toBe("string");
      expect(room.id.length).toBeGreaterThan(0);
      expect(room.description).toBe("a dim room");
      expect(room.name).toBe("A Dim Room");
    });

    it("starts with no occupants", () => {
      expect(makeRoom().occupants).toEqual([]);
    });

    it("keys the loot map by each loot batch's id", () => {
      const first = makeLoot();
      const second = makeLoot();
      const room = makeRoom([first, second]);

      expect(room.loot.size).toBe(2);
      expect(room.loot.get(first.id)).toBe(first);
      expect(room.loot.get(second.id)).toBe(second);
    });

    it("keys the exits map by direction", () => {
      const north = makeRoom();
      const room = makeRoom([], { north });

      expect(room.exits.get("north")).toBe(north);
    });

    it("keys the materials map by each cache's id", () => {
      const first = new MaterialCache({ metal: 1 });
      const second = new MaterialCache({ glass: 2 });
      const room = new Room("A Dim Room", "a dim room", [], {} as ExitsArg, [
        first,
        second,
      ]);

      expect(room.materials.size).toBe(2);
      expect(room.materials.get(first.id)).toBe(first);
      expect(room.materials.get(second.id)).toBe(second);
    });

    it("defaults to no material caches", () => {
      expect(makeRoom().materials.size).toBe(0);
    });
  });

  describe("occupants", () => {
    it("throws when assigned directly", () => {
      const room = makeRoom();

      expect(() => {
        (room as unknown as { occupants: ICharacter[] }).occupants = [];
      }).toThrow(ProceduralViolation);
    });
  });

  describe("enterRoom", () => {
    it("adds the character to the occupants", () => {
      const room = makeRoom();
      const character = makeCharacter();

      room.enterRoom(character);

      expect(room.occupants).toContain(character);
    });

    it("keeps a single entry when the same character enters twice", () => {
      const room = makeRoom();
      const character = makeCharacter();

      room.enterRoom(character);
      room.enterRoom(character);

      expect(room.occupants).toEqual([character]);
    });

    it("plays registered scenes with the 'enter' phase and this room", () => {
      const room = makeRoom();
      const scene = makeScene();
      room.registerScene(scene as unknown as Scene);

      room.enterRoom(makeCharacter());

      expect(scene.playScene).toHaveBeenCalledWith("enter", room);
    });
  });

  describe("exitRoom", () => {
    it("removes the character from the occupants", () => {
      const room = makeRoom();
      const character = makeCharacter();
      room.enterRoom(character);

      room.exitRoom(character);

      expect(room.occupants).not.toContain(character);
    });

    it("leaves other occupants in place", () => {
      const room = makeRoom();
      const staying = makeCharacter();
      const leaving = makeCharacter();
      room.enterRoom(staying);
      room.enterRoom(leaving);

      room.exitRoom(leaving);

      expect(room.occupants).toEqual([staying]);
    });

    it("plays registered scenes with the 'exit' phase and this room", () => {
      const room = makeRoom();
      const scene = makeScene();
      room.registerScene(scene as unknown as Scene);
      const character = makeCharacter();
      room.enterRoom(character);
      scene.playScene.mockClear();

      room.exitRoom(character);

      expect(scene.playScene).toHaveBeenCalledWith("exit", room);
    });
  });

  describe("addExit", () => {
    it("adds a new exit in the given direction", () => {
      const room = makeRoom();
      const east = makeRoom();

      room.addExit("east", east);

      expect(room.exits.get("east")).toBe(east);
    });

    it("overwrites an existing exit in the same direction", () => {
      const original = makeRoom();
      const replacement = makeRoom();
      const room = makeRoom([], { south: original });

      room.addExit("south", replacement);

      expect(room.exits.get("south")).toBe(replacement);
    });
  });

  describe("removeExit", () => {
    it("removes the exit in the given direction", () => {
      const west = makeRoom();
      const room = makeRoom([], { west });

      room.removeExit("west");

      expect(room.exits.has("west")).toBe(false);
    });

    it("is a no-op for a direction with no exit", () => {
      const room = makeRoom();

      expect(() => room.removeExit("north")).not.toThrow();
      expect(room.exits.has("north")).toBe(false);
    });
  });

  describe("registerScene", () => {
    it("registers a scene so it plays on room entry", () => {
      const room = makeRoom();
      const scene = makeScene();

      room.registerScene(scene as unknown as Scene);
      room.enterRoom(makeCharacter());

      expect(scene.playScene).toHaveBeenCalledOnce();
    });

    it("plays every registered scene", () => {
      const room = makeRoom();
      const first = makeScene();
      const second = makeScene();
      room.registerScene(first as unknown as Scene);
      room.registerScene(second as unknown as Scene);

      room.enterRoom(makeCharacter());

      expect(first.playScene).toHaveBeenCalledWith("enter", room);
      expect(second.playScene).toHaveBeenCalledWith("enter", room);
    });
  });
});
