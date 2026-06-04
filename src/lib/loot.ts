import { Brand } from "./brand";
import { IItem, ItemId } from "./inventory";
import {
  ContainerFullException,
  generateId,
  ProceduralViolation,
} from "./util";

export type LootId = Brand<string, "LootId">;

export interface ILoot {
  id: LootId;
  description: string;
  contents: IItem[];
  removeItems: (itemId: ItemId | ItemId[]) => IItem[];
  stowItem: (item: IItem) => void;
  readonly spaces: number;
}

export class Loot implements ILoot {
  id: LootId;
  description: string;
  contents: IItem[];
  #spaces: number;

  get spaces() {
    return this.#spaces;
  }

  constructor(description: string, contents: IItem[]) {
    this.id = generateId<LootId>();
    this.description = description;
    this.contents = contents;
    this.#spaces = contents.length + 2;
  }

  removeItems(itemId: ItemId | ItemId[]) {
    const items: IItem[] = [];
    const ids = Array.isArray(itemId) ? itemId : [itemId];

    for (const id of ids) {
      try {
        const item = this.contents.find((value) => value.id === id);
        if (!item) {
          throw new ProceduralViolation(
            "Attempted to remove an item from a container, but it was not there",
          );
        } else {
          items.push(item);
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Something happened that wasn't planned";
        console.warn(errorMessage);
      }
    }
    return items;
  }

  stowItem(item: IItem) {
    if (this.contents.length < this.spaces) {
      this.contents.push(item);
    } else {
      throw new ContainerFullException(this.id);
    }
  }
}
