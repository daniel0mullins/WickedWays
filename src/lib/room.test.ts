import { describe, expect, it, vi } from "vitest";

import { Character, type CharacterId, type ICharacter } from "./character/character";
import { StatType } from "./character/stats";
import { EquipmentSlot, SlotKind } from "./equipment";
import { ADD_LIGHT_SOURCE, Item, REMOVE_LIGHT_SOURCE, SET_DURABILITY } from "./inventory";
import type { ILoot, LootId } from "./loot";
import { MaterialCache } from "./material-cache";
import { Mob } from "./character/mob";
import { Room } from "./room";
import { Scene, type IScene } from "./scene";
import { ProceduralViolation } from "./util";
import type { Presentation } from "./presentation";
import type { MechanicCue } from "./mechanics/mechanic";

import { makeCampaign, makeStats } from "../test-utils";

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

function makeRoom(loot: ILoot[] = []): Room {
  return new Room({ name: "A Dim Room", description: "a dim room", loot });
}

// Only the item's `id` and `emitsLight` flag matter to these tests; the rest of
// the fields just satisfy the `Item` constructor.
function makeLight(): Item {
  const noop = () => {};
  return new Item({
    descriptor: { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Candle", slot: SlotKind.Hand, emitsLight: true },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

function makeDarkRoom(): Room {
  return new Room({
    name: "Cellar",
    description: "a pitch-black cellar",
    loot: [],
    dark: true,
  });
}

describe("Room", () => {
  describe("dark", () => {
    it("defaults to false", () => {
      expect(makeRoom().dark).toBe(false);
    });

    it("is true when authored dark", () => {
      expect(makeDarkRoom().dark).toBe(true);
    });
  });

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

    it("defaults to no loot when the option is omitted", () => {
      const room = new Room({ name: "A Dim Room", description: "a dim room" });

      expect(room.loot.size).toBe(0);
    });

    it("keys the exits map by direction", () => {
      const north = makeRoom();
      const room = makeRoom();
      room.addExit("north", north);

      expect(room.exits.get("north")!.otherSide(room)).toBe(north);
    });

    it("keys the materials map by each cache's id", () => {
      const first = new MaterialCache({ contents: { metal: 1 } });
      const second = new MaterialCache({ contents: { glass: 2 } });
      const room = new Room({
        name: "A Dim Room",
        description: "a dim room",
        loot: [],
        materials: [first, second],
      });

      expect(room.materials.size).toBe(2);
      expect(room.materials.get(first.id)).toBe(first);
      expect(room.materials.get(second.id)).toBe(second);
    });

    it("defaults to no material caches", () => {
      expect(makeRoom().materials.size).toBe(0);
    });
  });

  describe("addLoot / removeLoot", () => {
    it("adds a loot container keyed by its id", () => {
      const room = makeRoom();
      const chest = makeLoot();

      room.addLoot(chest);

      expect(room.loot.get(chest.id)).toBe(chest);
    });

    it("replaces a container already present under the same id", () => {
      const room = makeRoom();
      const chest = makeLoot();
      room.addLoot(chest);
      const replacement = makeLoot(chest.id);

      room.addLoot(replacement);

      expect(room.loot.size).toBe(1);
      expect(room.loot.get(chest.id)).toBe(replacement);
    });

    it("removes the container with the given id", () => {
      const chest = makeLoot();
      const room = makeRoom([chest]);

      room.removeLoot(chest.id);

      expect(room.loot.has(chest.id)).toBe(false);
    });

    it("is a no-op when removing an id that is not present", () => {
      const room = makeRoom();

      expect(() => room.removeLoot("missing" as LootId)).not.toThrow();
    });
  });

  describe("presentation", () => {
    it("exposes supplied presentation and is undefined when omitted", () => {
      const pres: Presentation = { image: "hall.png" };
      const withPres = new Room({ name: "Hall", description: "A hall", loot: [], presentation: pres });
      const without = new Room({ name: "Cell", description: "A cell", loot: [] });
      expect(withPres.presentation).toBe(pres);
      expect(without.presentation).toBeUndefined();
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
      room.registerScene(scene);

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
      room.registerScene(scene);
      const character = makeCharacter();
      room.enterRoom(character);
      scene.playScene.mockClear();

      room.exitRoom(character);

      expect(scene.playScene).toHaveBeenCalledWith("exit", room);
    });

    it("enterRoom collects enter-scene cues in registration order; exitRoom collects exit-scene cues", () => {
      const room = makeRoom();
      const character = makeCharacter();
      const mkScene = (phase: "enter" | "exit", text: string) =>
        new Scene({
          phase,
          preconditions: [],
          script: (): MechanicCue[] => [{ text }],
          behaviorKey: `test/${text}`,
        });
      room.registerScene(mkScene("enter", "a"));
      room.registerScene(mkScene("exit", "x"));
      room.registerScene(mkScene("enter", "b"));

      expect(room.enterRoom(character)).toEqual([{ text: "a" }, { text: "b" }]);
      expect(room.exitRoom(character)).toEqual([{ text: "x" }]);
    });
  });

  describe("addExit", () => {
    it("adds a new exit in the given direction", () => {
      const room = makeRoom();
      const east = makeRoom();

      room.addExit("east", east);

      expect(room.exits.get("east")!.otherSide(room)).toBe(east);
    });

    it("overwrites an existing exit in the same direction", () => {
      const original = makeRoom();
      const replacement = makeRoom();
      const room = makeRoom();
      room.addExit("south", original);

      room.addExit("south", replacement);

      expect(room.exits.get("south")!.otherSide(room)).toBe(replacement);
    });
  });

  describe("removeExit", () => {
    it("removes the exit in the given direction", () => {
      const west = makeRoom();
      const room = makeRoom();
      room.addExit("west", west);

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

      room.registerScene(scene);
      room.enterRoom(makeCharacter());

      expect(scene.playScene).toHaveBeenCalledOnce();
    });

    it("plays every registered scene", () => {
      const room = makeRoom();
      const first = makeScene();
      const second = makeScene();
      room.registerScene(first);
      room.registerScene(second);

      room.enterRoom(makeCharacter());

      expect(first.playScene).toHaveBeenCalledWith("enter", room);
      expect(second.playScene).toHaveBeenCalledWith("enter", room);
    });

    it("persists a registered scene's state across repeated enterRoom calls", () => {
      const body = vi.fn();
      const scene = new Scene<{ fired: boolean }>({
        preconditions: [(_room, state) => !state.fired],
        script: (_room, state) => {
          body();
          state.fired = true;
        },
        initialState: { fired: false },
      });
      const room = makeRoom();
      room.registerScene(scene);

      room.enterRoom(makeCharacter());
      room.enterRoom(makeCharacter());

      expect(body).toHaveBeenCalledOnce();
    });
  });

  describe("placeMob", () => {
    function makeMob() {
      return new Mob({ campaign: makeCampaign(), name: "Goblin", stats: makeStats(), inventorySlots: 2, actionsPerRound: 2, drops: [] });
    }

    it("seats the mob as an occupant in its current room with room origin", () => {
      const room = new Room({ name: "Lair", description: "Lair", loot: [] });
      const mob = makeMob();

      room.placeMob(mob);

      expect(room.occupants).toContain(mob);
      expect(mob.currentRoom).toBe(room);
    });

    it("seats resident mobs passed to the constructor", () => {
      const mob = makeMob();
      const room = new Room({ name: "Lair", description: "Lair", loot: [], mobs: [mob] });

      expect(room.occupants).toContain(mob);
      expect(mob.currentRoom).toBe(room);
    });

    it("defaults spawnModifier to 1", () => {
      const room = new Room({ name: "Hall", description: "Hall", loot: [] });
      expect(room.spawnModifier).toBe(1);
    });
  });

  describe("lightSources", () => {
    it("can be authored with light sources present", () => {
      const candle = makeLight();
      const room = new Room({ name: "Hall", description: "a hall", loot: [], dark: true, lightSources: [candle] });
      expect(room.lightSources.get(candle.id)).toBe(candle);
    });

    it("is mutated only through the symbol seams", () => {
      const room = makeRoom();
      const candle = makeLight();
      room[ADD_LIGHT_SOURCE](candle);
      expect(room.lightSources.get(candle.id)).toBe(candle);
      room[REMOVE_LIGHT_SOURCE](candle.id);
      expect(room.lightSources.has(candle.id)).toBe(false);
    });

    it("does not expose a public setter for lightSources", () => {
      const room = makeRoom();
      expect(() => {
        // @ts-expect-error lightSources is read-only
        room.lightSources = new Map();
      }).toThrow();
    });
  });

  describe("isLit", () => {
    // Helper: a Character holding an equipped, non-broken hand light.
    function makeLitHero(): Character {
      const hero = new Character({ campaign: makeCampaign(), name: "Torchbearer", stats: makeStats() });
      const noop = () => {};
      const torch = new Item({
        descriptor: { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Torch", slot: SlotKind.Hand, emitsLight: true },
        properties: { equippable: true, equipped: false, destroyable: true, usable: false },
        actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
        events: { onPickUp: noop },
      });
      hero.addToInventory(torch);
      hero.equip(torch, EquipmentSlot.LeftHand);
      return hero;
    }

    // Helper: a placed light that is broken (does not count toward isLit).
    function makeBrokenLight(): Item {
      const noop = () => {};
      const light = new Item({
        descriptor: { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Dead Lamp", slot: SlotKind.Hand, emitsLight: true, maxDurability: 1 },
        properties: { equippable: true, equipped: false, destroyable: true, usable: false },
        actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
        events: { onPickUp: noop },
      });
      light[SET_DURABILITY](0);
      return light;
    }

    it("a non-dark room is always lit, even with nothing", () => {
      expect(makeRoom().isLit).toBe(true);
    });

    it("a dark room with nothing is unlit", () => {
      expect(makeDarkRoom().isLit).toBe(false);
    });

    it("a dark room lit by a placed light source is lit", () => {
      const room = makeDarkRoom();
      room[ADD_LIGHT_SOURCE](makeLight());
      expect(room.isLit).toBe(true);
    });

    it("a dark room is not lit by a broken placed light source", () => {
      const room = makeDarkRoom();
      room[ADD_LIGHT_SOURCE](makeBrokenLight());
      expect(room.isLit).toBe(false);
    });

    it("a dark room is lit by an occupant carrying an equipped light", () => {
      const room = makeDarkRoom();
      room.enterRoom(makeLitHero());
      expect(room.isLit).toBe(true);
    });

    it("goes dark again when the carried light's holder leaves", () => {
      const room = makeDarkRoom();
      const hero = makeLitHero();
      room.enterRoom(hero);
      room.exitRoom(hero);
      expect(room.isLit).toBe(false);
    });
  });
});
