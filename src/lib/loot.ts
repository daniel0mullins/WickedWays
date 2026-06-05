import { Brand } from "./brand";
import { CLAIM, IItem, IItemHolder, ItemId } from "./inventory";
import { ContainerFullException, generateId } from "./util";

export type LootId = Brand<string, "LootId">;

export interface ILoot extends IItemHolder {
  readonly holderKind: "loot";
  id: LootId;
  description: string;
  contents: IItem[];
  removeItems: (itemId: ItemId | ItemId[]) => IItem[];
  stowItem: (item: IItem) => void;
  readonly capacity: number;
}

export class Loot implements ILoot {
  readonly holderKind = "loot" as const;
  id: LootId;
  description: string;
  contents: IItem[];
  #capacity: number;

  get capacity() {
    return this.#capacity;
  }

  constructor(description: string, contents: IItem[]) {
    this.id = generateId<LootId>();
    this.description = description;
    this.contents = contents;
    this.#capacity = contents.length + 2;
    for (const item of contents) {
      item[CLAIM](this);
    }
  }

  removeItems(itemId: ItemId | ItemId[]) {
    const items: IItem[] = [];
    const ids = Array.isArray(itemId) ? itemId : [itemId];

    for (const id of ids) {
      const index = this.contents.findIndex((value) => value.id === id);
      if (index === -1) {
        console.warn(
          "Attempted to remove an item from a container, but it was not there",
        );
        continue;
      }
      items.push(...this.contents.splice(index, 1));
    }
    return items;
  }

  hasRoomForItem() {
    return this.contents.length < this.#capacity;
  }

  receiveItem(item: IItem) {
    this.contents.push(item);
    item[CLAIM](this);
  }

  relinquishItem(item: IItem) {
    const index = this.contents.findIndex((value) => value.id === item.id);
    if (index !== -1) {
      this.contents.splice(index, 1);
    }
  }

  stowItem(item: IItem) {
    if (this.hasRoomForItem()) {
      this.receiveItem(item);
    } else {
      throw new ContainerFullException(this.id);
    }
  }
}
