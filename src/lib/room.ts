import { Brand } from "./brand";
import { CharacterId, ICharacter } from "./character/character";
import { IItem, ItemId } from "./inventory";
import { ILoot, LootId } from "./loot";
import {
  ContainerFullException,
  generateId,
  ProceduralViolation,
} from "./util";

export type RoomId = Brand<string, "RoomId">;

const Directions = {
  North: "north",
  South: "south",
  Southeast: "southeast",
  East: "east",
  Northeast: "northeast",
  West: "west",
  Northwest: "northwest",
  SouthWest: "southwest",
} as const;

type Direction = (typeof Directions)[keyof typeof Directions];

export interface IRoom {
  id: RoomId;
  description: string;
  loot: Map<LootId, ILoot>;
  exits: Map<Direction, IRoom>;
  get occupants(): ICharacter[];
  // occupants: Map<CharacterId, ICharacter>;
  enterRoom: (character: ICharacter) => void;
  exitRoom: (character: ICharacter) => void;
  addExit: (direction: Direction, room: IRoom) => void;
  removeExit: (direction: Direction) => void;
}

export class Room implements IRoom {
  id: RoomId;
  description: string;
  loot: Map<LootId, ILoot>;
  exits: Map<Direction, IRoom>;
  #occupants: Map<CharacterId, ICharacter>;

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
  }

  exitRoom(character: ICharacter) {
    this.#occupants.delete(character.id);
  }

  addExit(direction: Direction, room: IRoom) {
    this.exits.set(direction, room);
  }

  removeExit(direction: Direction) {
    this.exits.delete(direction);
  }
}
