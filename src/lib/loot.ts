import { Brand } from "./brand";
import { CLAIM, IItem, IItemHolder, ItemId } from "./inventory";
import { ContainerFullException, ProceduralViolation, generateId } from "./util";

/** Unique identifier for a {@link Loot} container. */
export type LootId = Brand<string, "LootId">;

/**
 * A loot container: an {@link IItemHolder} that stores items in a room for
 * characters to take from or stow into, up to a fixed {@link ILoot.capacity}.
 */
export interface ILoot extends IItemHolder {
  readonly holderKind: "loot";
  id: LootId;
  description: string;
  contents: IItem[];
  /** Removes and returns the items matching the given id(s), if present. */
  removeItems: (itemId: ItemId | ItemId[]) => IItem[];
  /** Adds an item to the container, throwing if it is already full. */
  stowItem: (item: IItem) => void;
  /** Maximum number of items the container can hold. */
  readonly capacity: number;
}

/**
 * Default {@link ILoot} implementation. Capacity is sized to its initial
 * contents plus a small headroom, and every starting item is claimed by the box
 * on construction.
 */
export class Loot implements ILoot {
  readonly holderKind = "loot" as const;
  id: LootId;
  description: string;
  contents: IItem[];
  #capacity: number;

  get capacity() {
    return this.#capacity;
  }

  /**
   * @param description - Flavour text describing the container.
   * @param contents - Initial items; capacity is set to their count plus 2 and
   *   each is claimed by this container.
   * @throws {@link ProceduralViolation} if any initial item is a key.
   */
  constructor(description: string, contents: IItem[]) {
    if (contents.some((item) => item.type === "key")) {
      throw new ProceduralViolation("Keys cannot be stored in a loot container.");
    }
    this.id = generateId<LootId>();
    this.description = description;
    this.contents = contents;
    this.#capacity = contents.length + 2;
    for (const item of contents) {
      item[CLAIM](this);
    }
  }

  /**
   * Removes the items matching the given id(s) from the container.
   *
   * Ids not present are skipped with a warning rather than throwing.
   *
   * @param itemId - A single item id or an array of ids to remove.
   * @returns The items that were found and removed.
   */
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

  /** @returns Whether the container is below capacity. */
  hasRoomForItem() {
    return this.contents.length < this.#capacity;
  }

  /**
   * Adds `item` to the contents and claims it, without a capacity check.
   * Prefer {@link Loot.stowItem} for the guarded variant.
   *
   * @throws {@link ProceduralViolation} if `item` is a key.
   */
  receiveItem(item: IItem) {
    if (item.type === "key") {
      throw new ProceduralViolation("Keys cannot be stored in a loot container.");
    }
    this.contents.push(item);
    item[CLAIM](this);
  }

  /** Removes `item` from the contents if present, leaving its holder untouched. */
  relinquishItem(item: IItem) {
    const index = this.contents.findIndex((value) => value.id === item.id);
    if (index !== -1) {
      this.contents.splice(index, 1);
    }
  }

  /**
   * Stows `item` into the container.
   *
   * @param item - The item to add.
   * @throws {@link ContainerFullException} if the container is already at capacity.
   */
  stowItem(item: IItem) {
    if (this.hasRoomForItem()) {
      this.receiveItem(item);
    } else {
      throw new ContainerFullException(this.id);
    }
  }
}
