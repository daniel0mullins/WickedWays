import { Brand } from "./brand";
import { CharacterId, ICharacter } from "./character/character";
import { ILoot, LootId } from "./loot";
import { IScene, Scene } from "./scene";
import { generateId, ProceduralViolation } from "./util";

export type RoomId = Brand<string, "RoomId">;

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

type Direction = (typeof Directions)[keyof typeof Directions];

export interface IRoom {
  id: RoomId;
  description: string;
  loot: Map<LootId, ILoot>;
  exits: Map<Direction, IRoom>;

  get occupants(): ICharacter[];

  enterRoom: (character: ICharacter) => void;
  exitRoom: (character: ICharacter) => void;
  addExit: (direction: Direction, room: IRoom) => void;
  registerScene: (scene: Scene) => void;
  removeExit: (direction: Direction) => void;
}

export class Room implements IRoom {
  id: RoomId;
  description: string;
  loot: Map<LootId, ILoot>;
  exits: Map<Direction, IRoom>;
  #occupants: Map<CharacterId, ICharacter>;
  #scenes: IScene[];

  get occupants() {
    return [...this.#occupants.values()];
  }

  set occupants(_) {
    throw new ProceduralViolation("Cannot set 'occupants' directly");
  }

  constructor(
    description: string,
    loot: ILoot[],
    exits: Record<Direction, IRoom>,
  ) {
    this.id = generateId<RoomId>();
    this.description = description;
    this.#occupants = new Map<CharacterId, ICharacter>();
    this.#scenes = [];

    this.loot = new Map<LootId, ILoot>();
    for (const lootBatch of loot) {
      this.loot.set(lootBatch.id, lootBatch);
    }

    this.exits = new Map<Direction, IRoom>();
    for (const [direction, room] of Object.entries(exits)) {
      this.exits.set(direction as Direction, room);
    }
  }

  enterRoom(character: ICharacter) {
    this.#occupants.set(character.id, character);
    this.#scenes.forEach((scene) => scene.playScene("enter", this));
  }

  exitRoom(character: ICharacter) {
    this.#scenes.forEach((scene) => scene.playScene("exit", this));
    this.#occupants.delete(character.id);
  }

  addExit(direction: Direction, room: IRoom) {
    this.exits.set(direction, room);
  }

  registerScene(scene: Scene) {
    this.#scenes.push(scene);
  }

  removeExit(direction: Direction) {
    this.exits.delete(direction);
  }
}
