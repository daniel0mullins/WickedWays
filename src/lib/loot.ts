import { Brand } from "./brand";
import { CLAIM, IItem, IItemHolder, ItemId, STASH_DROP } from "./inventory";
import { ContainerFullException, ProceduralViolation, generateId } from "./util";
import type { Presentation } from "./presentation";
import { HYDRATE, SERIALIZE } from "./serialization/symbols";
import type { LootSnapshot } from "./serialization/types";
import type { HydrateContext } from "./serialization/context";

/** Unique identifier for a {@link Loot} container. */
export type LootId = Brand<string, "LootId">;

/**
 * Engine-internal seam: sets `#capacity` on a {@link Loot} during hydration so
 * the restored snapshot value is preserved exactly as persisted.
 */
export const SET_CAPACITY = Symbol("setLootCapacity");

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
  /**
   * Forces `item` into the container — including a key, and past capacity —
   * claiming it. The caller must first relinquish it from its current holder.
   * Engine-internal defeat-drop seam; players use {@link stowItem}.
   */
  [STASH_DROP]: (item: IItem) => void;
  /** Maximum number of items the container can hold. */
  readonly capacity: number;
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
  /** Returns a plain-data snapshot of this loot container. See {@link SERIALIZE}. */
  [SERIALIZE](): LootSnapshot;
}

/** Constructor options for a {@link Loot} container. */
export interface LootOptions {
  /** Flavour text describing the container. */
  description: string;
  /**
   * Initial items; capacity is set to their count plus 2 and each is claimed by
   * this container.
   */
  contents: IItem[];
  /** Optional presentation metadata (image/sound). */
  presentation?: Presentation;
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
  #presentation?: Presentation;

  get capacity() {
    return this.#capacity;
  }

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }

  /**
   * @param opts - See {@link LootOptions}.
   */
  constructor(opts: LootOptions) {
    const { description, contents, presentation } = opts;
    this.id = generateId<LootId>();
    this.description = description;
    this.contents = contents;
    this.#capacity = contents.length + 2;
    this.#presentation = presentation;
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

  [STASH_DROP](item: IItem) {
    this.contents.push(item);
    item[CLAIM](this);
  }

  /** Engine-internal: restores `#capacity` from a persisted snapshot. */
  [SET_CAPACITY](value: number) {
    this.#capacity = value;
  }

  /** Returns a plain-data snapshot suitable for persistence. */
  [SERIALIZE](): LootSnapshot {
    return {
      id: this.id,
      description: this.description,
      capacity: this.capacity,
      contentIds: this.contents.map((i) => i.id),
    };
  }

  /** In-place restore of mutable loot state; resets contents before filling to prevent duplication. */
  [HYDRATE](data: LootSnapshot, ctx: HydrateContext): void {
    this.description = data.description;
    this.contents = [];
    this[SET_CAPACITY](data.capacity);
    for (const itemId of data.contentIds) {
      this[STASH_DROP](ctx.item(itemId));
    }
  }
}

/**
 * Reconstructs a {@link Loot} from its snapshot. Contents must already be
 * indexed in `ctx` (items hydrate before containers in the deserializer ordering).
 *
 * @param data - Plain-data snapshot produced by {@link Loot[SERIALIZE]}.
 * @param ctx - Hydration context carrying the id→instance index and registry.
 * @returns The reconstructed loot box, registered in `ctx`.
 */
export function hydrateLoot(data: LootSnapshot, ctx: HydrateContext): Loot {
  const loot = new Loot({ description: data.description, contents: [] });
  loot.id = data.id as LootId;
  loot[HYDRATE](data, ctx);
  ctx.put(loot.id, loot);
  return loot;
}
