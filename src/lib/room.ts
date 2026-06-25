import { Brand } from "./brand";
import { CharacterId, ICharacter } from "./character/character";
import { ADD_LIGHT_SOURCE, IItem, ItemId, PLACE, REMOVE_LIGHT_SOURCE, SET_ORIGIN } from "./inventory";
import { ILoot, LootId } from "./loot";
import type { IMaterialCache, MaterialCacheId } from "./material-cache";
import type { IMob } from "./character/mob";
import { IScene, hydrateScene } from "./scene";
import { generateId, ProceduralViolation } from "./util";
import type { Presentation } from "./presentation";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import type { RoomSnapshot } from "./serialization/types";
import type { HydrateContext } from "./serialization/context";
import { Exit, SET_ENDPOINTS, type ExitPrecondition, type ExitScript } from "./exit";

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
export type Direction = (typeof Directions)[keyof typeof Directions];

const REVERSE: Record<Direction, Direction> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  northeast: "southwest",
  southwest: "northeast",
  northwest: "southeast",
  southeast: "northwest",
};

/** Returns the compass direction directly opposite to `d`. */
export function reverseDirection(d: Direction): Direction {
  return REVERSE[d];
}

/**
 * The exits a {@link Room} is constructed with: a partial map from direction to
 * the {@link Exit} in that direction. Defaults to empty; wire later via
 * {@link Room.addExit}.
 */
export type RoomExits = Partial<Record<Direction, Exit>>;

/** Options for {@link Room.addExit}. */
export interface AddExitOptions {
  behaviorKey?: string;
  passMessage?: string;
  failMessage?: string;
  /** Optional display label for the exit (e.g. "Iron Door"). Survives serialization. */
  name?: string;
  initialState?: Record<string, unknown>;
  preconditions?: ExitPrecondition<never>[];
  script?: ExitScript<never>;
  /** When true, the exit is placed only in this room (not auto-reversed into the partner). */
  oneWay?: boolean;
}

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
  /** Exits keyed by the direction that leads out of this room. Each exit is a shared bidirectional {@link Exit}. */
  exits: Map<Direction, Exit>;
  /** Multiplier on the campaign's base encounter chance (0 = never spawns). */
  spawnModifier: number;

  /** Characters currently in the room. */
  get occupants(): ICharacter[];

  /** Records a character as present and plays any `"enter"` scenes. */
  enterRoom: (character: ICharacter) => void;
  /** Plays any `"exit"` scenes and removes the character from the room. */
  exitRoom: (character: ICharacter) => void;
  /**
   * Builds one shared {@link Exit} connecting this room to `to` in `direction`,
   * and (unless `opts.oneWay`) places the same exit in `to` under the reverse direction.
   */
  addExit: (direction: Direction, to: IRoom, opts?: AddExitOptions) => void;
  /** Registers a scene to be considered on enter/exit. */
  registerScene: (scene: IScene) => void;
  /** Removes the exit in `direction`, if any. */
  removeExit: (direction: Direction) => void;
  /** Adds a loot container to the room (keyed by its id; replaces any with the same id). */
  addLoot: (loot: ILoot) => void;
  /** Removes the loot container with `id` from the room, if present. */
  removeLoot: (id: LootId) => void;
  /** Seats `mob` as a room-attached resident (origin `"room"`). */
  placeMob: (mob: IMob) => void;
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
  /** Author-time darkness flag. A dark room conceals its contents until lit. Fixed at authoring. */
  get dark(): boolean;
  /** Active placed light sources resident in this room, keyed by item id. Read-only. */
  get lightSources(): ReadonlyMap<ItemId, IItem>;
  /** Whether the room is currently lit (always true for non-dark rooms). */
  get isLit(): boolean;
  [ADD_LIGHT_SOURCE](item: IItem): void;
  [REMOVE_LIGHT_SOURCE](id: ItemId): void;
  /** Returns a plain-data snapshot of this room's state. See {@link SERIALIZE}. */
  [SERIALIZE](): RoomSnapshot;
}

/**
 * Constructor options for {@link Room}. Follows the established `XOptions`
 * pattern used for MaterialCache/Loot/Item/Character.
 */
export interface RoomOptions {
  /** Display name of the room. */
  name: string;
  /** Flavour text shown to players. */
  description: string;
  /** Loot containers initially present in the room. Defaults to none. */
  loot?: ILoot[];
  /**
   * Initial exits keyed by direction. Optional; defaults to none, leaving the
   * room to be connected later (e.g. by `buildMap`).
   */
  exits?: RoomExits;
  /** Material caches initially present in the room. Defaults to none. */
  materials?: IMaterialCache[];
  /**
   * Multiplier on the campaign's base encounter chance (default 1; 0 = never
   * spawns).
   */
  spawnModifier?: number;
  /**
   * Resident mobs seated immediately via {@link Room.placeMob} (origin
   * `"room"`). Defaults to none.
   */
  mobs?: IMob[];
  /** Optional presentation metadata (image/sound). */
  presentation?: Presentation;
  /**
   * Author-time darkness flag (default `false`); a dark room conceals its
   * contents until lit.
   */
  dark?: boolean;
  /** Light sources initially present in the room (keyed by item id). Defaults to none. */
  lightSources?: IItem[];
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
  exits: Map<Direction, Exit>;
  spawnModifier: number;
  #occupants: Map<CharacterId, ICharacter>;
  #scenes: IScene[];
  #presentation?: Presentation;
  #dark: boolean;
  #lightSources: Map<ItemId, IItem>;

  get occupants() {
    return [...this.#occupants.values()];
  }

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }

  /** Author-time darkness flag. A dark room conceals its contents until lit. Fixed at authoring. */
  get dark(): boolean {
    return this.#dark;
  }

  /** Active placed light sources resident in this room, keyed by item id. Read-only. */
  get lightSources(): ReadonlyMap<ItemId, IItem> {
    return this.#lightSources;
  }

  /**
   * Whether the room is currently lit. A non-dark room is always lit. A dark room
   * is lit iff it holds a non-broken placed light source, or an occupant carries
   * an equipped, non-broken light.
   */
  get isLit(): boolean {
    if (!this.#dark) return true;
    for (const light of this.#lightSources.values()) {
      if (!light.isBroken) return true;
    }
    return this.occupants.some((occupant) => occupant.hasLight);
  }

  [ADD_LIGHT_SOURCE](item: IItem) {
    this.#lightSources.set(item.id, item);
  }

  [REMOVE_LIGHT_SOURCE](id: ItemId) {
    this.#lightSources.delete(id);
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
   * Options for constructing a {@link Room}. Mirrors the established
   * `XOptions` pattern used elsewhere (MaterialCache/Loot/Item/Character).
   */
  constructor(opts: RoomOptions) {
    const {
      name,
      description,
      loot = [],
      exits = {},
      materials = [],
      spawnModifier = 1,
      mobs = [],
      presentation,
      dark = false,
      lightSources = [],
    } = opts;
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

    this.exits = new Map<Direction, Exit>();
    for (const [direction, exit] of Object.entries(exits)) {
      if (exit === undefined) continue;
      this.exits.set(direction as Direction, exit);
    }

    this.#lightSources = new Map<ItemId, IItem>();
    for (const light of lightSources) {
      this.#lightSources.set(light.id, light);
    }

    this.spawnModifier = spawnModifier;
    this.#presentation = presentation;
    this.#dark = dark;

    for (const mob of mobs) {
      this.placeMob(mob);
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
   * Builds one shared {@link Exit} connecting this room to `to` in `direction`.
   * Unless `opts.oneWay`, also places the exit in `to` under the reverse direction.
   */
  addExit(direction: Direction, to: IRoom, opts: AddExitOptions = {}) {
    const exit = new Exit<never>({
      preconditions: opts.preconditions ?? [],
      script: opts.script,
      passMessage: opts.passMessage,
      failMessage: opts.failMessage,
      name: opts.name,
      initialState: opts.initialState as never,
      behaviorKey: opts.behaviorKey,
    });
    exit[SET_ENDPOINTS](this, to);
    this.exits.set(direction, exit as unknown as Exit);
    if (!opts.oneWay) to.exits.set(reverseDirection(direction), exit as unknown as Exit);
  }

  /** Registers a scene to evaluate when characters enter or exit. */
  registerScene(scene: IScene) {
    this.#scenes.push(scene);
  }

  /** Removes the exit in `direction`, if one exists. */
  removeExit(direction: Direction) {
    this.exits.delete(direction);
  }

  /**
   * Adds a loot container to the room, keyed by its id. A container already
   * present under the same id is replaced.
   */
  addLoot(loot: ILoot) {
    this.loot.set(loot.id, loot);
  }

  /** Removes the loot container with `id` from the room, if present. */
  removeLoot(id: LootId) {
    this.loot.delete(id);
  }

  /**
   * Seats `mob` as a room-attached resident: marks its origin `"room"` and wires
   * it into this room as an occupant. Room-attached mobs may drop key items on
   * defeat (see {@link Mob.onKnockOut}).
   */
  placeMob(mob: IMob) {
    mob[SET_ORIGIN]("room");
    mob[PLACE](this);
  }

  /** Returns a plain-data snapshot of this room's state. */
  [SERIALIZE](): RoomSnapshot {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      exits: Object.fromEntries([...this.exits].map(([dir, exit]) => [dir, exit.id])),
      dark: this.#dark,
      spawnModifier: this.spawnModifier,
      occupantIds: [...this.#occupants.keys()],
      lootIds: [...this.loot.keys()],
      materialCacheIds: [...this.materials.keys()],
      lightSourceIds: [...this.#lightSources.keys()],
      scenes: this.#scenes.map((s) => s[SERIALIZE]()),
    };
  }

  /**
   * Wires all references (exits, loot, materials, light sources, occupants, scenes)
   * from the hydration context index into this bare room. Called in pass 2.
   */
  [HYDRATE](data: RoomSnapshot, ctx: HydrateContext) {
    this.exits.clear();
    for (const [dir, exitId] of Object.entries(data.exits)) {
      this.exits.set(dir as Direction, ctx.exit(exitId) as unknown as Exit);
    }
    this.loot.clear();
    for (const lootId of data.lootIds) {
      const loot = ctx.loot(lootId);
      this.loot.set(loot.id, loot);
    }
    this.materials.clear();
    for (const cacheId of data.materialCacheIds) {
      const cache = ctx.materialCache(cacheId);
      this.materials.set(cache.id, cache);
    }
    this.#lightSources.clear();
    for (const itemId of data.lightSourceIds) {
      const light = ctx.item(itemId);
      this.#lightSources.set(light.id, light);
    }
    this.#occupants.clear();
    for (const charId of data.occupantIds) {
      const character = ctx.character(charId);
      this.#occupants.set(character.id, character);
    }
    this.#scenes.length = 0;
    for (const sceneData of data.scenes) {
      this.registerScene(hydrateScene(sceneData, ctx));
    }
  }
}

/**
 * Pass-1 factory: builds a bare {@link Room} with empty collections from a
 * {@link RoomSnapshot}. The caller must assign the returned room into
 * `HydrateContext` before running pass 2 ({@link Room[HYDRATE]}).
 */
export function constructBareRoom(data: RoomSnapshot): Room {
  const room = new Room({
    name: data.name,
    description: data.description,
    loot: [],
    spawnModifier: data.spawnModifier,
    dark: data.dark,
  });
  room.id = data.id as RoomId;
  return room;
}
