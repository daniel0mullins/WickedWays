import { Brand } from "./brand";
import { CharacterId, ICharacter } from "./character/character";
import { ILoot, LootId } from "./loot";
import type { IMaterialCache, MaterialCacheId } from "./material-cache";
import { IScene, Scene } from "./scene";
import { generateId, ProceduralViolation } from "./util";

/** Unique identifier for a {@link Room}. */
export type RoomId = Brand<string, "RoomId">;

/** The eight compass directions a room exit can point in. */
export const Directions = {
  North: "north",
  South: "south",
  Southeast: "southeast",
  East: "east",
  Northeast: "northeast",
  West: "west",
  Northwest: "northwest",
  Southwest: "southwest",
} as const;

/** One of the {@link Directions} values. */
type Direction = (typeof Directions)[keyof typeof Directions];

/**
 * A location in the game world. Rooms hold loot, track their occupants, connect
 * to other rooms via directional exits, and run {@link Scene}s as characters
 * enter or leave.
 */
export interface IRoom {
  id: RoomId;
  name: string;
  description: string;
  /** Loot containers present in the room, keyed by id. */
  loot: Map<LootId, ILoot>;
  /** Material caches present in the room, keyed by id. */
  materials: Map<MaterialCacheId, IMaterialCache>;
  /** Adjacent rooms keyed by the direction that leads to them. */
  exits: Map<Direction, IRoom>;

  /** Characters currently in the room. */
  get occupants(): ICharacter[];

  /** Records a character as present and plays any `"enter"` scenes. */
  enterRoom: (character: ICharacter) => void;
  /** Plays any `"exit"` scenes and removes the character from the room. */
  exitRoom: (character: ICharacter) => void;
  /** Connects `room` as the exit in `direction` (one-way at this level). */
  addExit: (direction: Direction, room: IRoom) => void;
  /** Registers a scene to be considered on enter/exit. */
  registerScene: (scene: Scene) => void;
  /** Removes the exit in `direction`, if any. */
  removeExit: (direction: Direction) => void;
}

/**
 * Default {@link IRoom} implementation. Occupants are tracked in a private map
 * keyed by character id and exposed as a read-only array; assigning to
 * `occupants` throws.
 */
export class Room implements IRoom {
  id: RoomId;
  name: string;
  description: string;
  loot: Map<LootId, ILoot>;
  materials: Map<MaterialCacheId, IMaterialCache>;
  exits: Map<Direction, IRoom>;
  #occupants: Map<CharacterId, ICharacter>;
  #scenes: IScene[];

  get occupants() {
    return [...this.#occupants.values()];
  }

  /**
   * Guards against replacing the occupant set directly.
   * @throws {@link ProceduralViolation} always — use {@link Room.enterRoom} /
   *   {@link Room.exitRoom}.
   */
  set occupants(_) {
    throw new ProceduralViolation("Cannot set 'occupants' directly");
  }

  /**
   * @param name - Display name of the room.
   * @param description - Flavour text shown to players.
   * @param loot - Loot containers initially present in the room.
   * @param exits - Initial exits keyed by direction.
   * @param materials - Material caches initially present in the room.
   */
  constructor(
    name: string,
    description: string,
    loot: ILoot[],
    exits: Record<Direction, IRoom>,
    materials: IMaterialCache[] = [],
  ) {
    this.id = generateId<RoomId>();
    this.name = name;
    this.description = description;
    this.#occupants = new Map<CharacterId, ICharacter>();
    this.#scenes = [];

    this.loot = new Map<LootId, ILoot>();
    for (const lootBatch of loot) {
      this.loot.set(lootBatch.id, lootBatch);
    }

    this.materials = new Map<MaterialCacheId, IMaterialCache>();
    for (const cache of materials) {
      this.materials.set(cache.id, cache);
    }

    this.exits = new Map<Direction, IRoom>();
    for (const [direction, room] of Object.entries(exits)) {
      this.exits.set(direction as Direction, room);
    }
  }

  /**
   * Adds `character` to the room's occupants and plays every `"enter"` scene.
   * @param character - The character entering the room.
   */
  enterRoom(character: ICharacter) {
    this.#occupants.set(character.id, character);
    this.#scenes.forEach((scene) => scene.playScene("enter", this));
  }

  /**
   * Plays every `"exit"` scene and then removes `character` from the occupants.
   * @param character - The character leaving the room.
   */
  exitRoom(character: ICharacter) {
    this.#scenes.forEach((scene) => scene.playScene("exit", this));
    this.#occupants.delete(character.id);
  }

  /**
   * Sets the exit in `direction` to `room`. An existing exit in that direction
   * is overwritten.
   *
   * @param direction - Direction the exit leads.
   * @param room - Destination room.
   */
  addExit(direction: Direction, room: IRoom) {
    this.exits.set(direction, room);
  }

  /** Registers a scene to evaluate when characters enter or exit. */
  registerScene(scene: Scene) {
    this.#scenes.push(scene);
  }

  /** Removes the exit in `direction`, if one exists. */
  removeExit(direction: Direction) {
    this.exits.delete(direction);
  }
}
