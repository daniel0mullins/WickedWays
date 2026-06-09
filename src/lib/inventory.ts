import { Brand } from "./brand";
import type { ICharacter } from "./character/character";
import type { ILoot } from "./loot";
import type { RequireAtLeastOne } from "type-fest";
import { v4 as uuid } from "uuid";
import { StatType } from "./character/stats";
import { ProceduralViolation } from "./util";

/** The kinds of item the engine recognises. */
const ItemType = {
  Consumable: "consumable",
  Armor: "armor",
  Weapon: "weapon",
  Throwable: "throwable",
  Key: "key",
} as const;

/** Unique identifier for an {@link Item}. */
export type ItemId = Brand<string, "ItemId">;
type ItemType = (typeof ItemType)[keyof typeof ItemType];

/** Raw materials an item is made of and yields when destroyed. */
const ItemComponentType = {
  Metal: "metal",
  Glass: "glass",
  Electronics: "electronics",
  Healing: "healing",
  Food: "food",
  Item: "item",
} as const;
type ItemComponentType =
  (typeof ItemComponentType)[keyof typeof ItemComponentType];

/** Component-to-quantity makeup of an item; at least one component is required. */
type Recipe = RequireAtLeastOne<{
  [k in ItemComponentType]: number;
}>;

/** Item action callback acting on a single character (optionally with components). */
type ItemActionEvent = <C extends ICharacter>(
  c: C,
  components?: ItemComponentType[] | null,
) => void;

/** Item action callback acting between two characters (e.g. a transfer). */
type ItemActionSharedEvent = <C extends ICharacter, CC extends ICharacter>(
  c: C,
  cc: CC,
) => void;

/** The interactions an item can be the subject of. */
const ItemAction = {
  PickUp: "pickUp",
  Equip: "equip",
  Unequip: "unequip",
  Transfer: "transfer",
  Destroy: "destroy",
  Use: "use",
} as const;

/**
 * The core behaviour each action performs, supplied when an {@link Item} is
 * constructed. The `Item` wraps these and fires the matching {@link ItemEvents}
 * hook after each runs.
 */
type ItemActions = {
  [ItemAction.PickUp]: ItemActionEvent;
  [ItemAction.Equip]: ItemActionEvent;
  [ItemAction.Unequip]: ItemActionEvent;
  [ItemAction.Transfer]: ItemActionSharedEvent;
  [ItemAction.Use]: ItemActionEvent;
  [ItemAction.Destroy]: () => ItemComponentType[] | null;
};

/**
 * Optional observer hooks fired after the corresponding {@link ItemActions}
 * behaviour runs. Only `onPickUp` is required.
 */
type ItemEvents = {
  onPickUp: ItemActionEvent;
  onEquip?: ItemActionEvent;
  onUnequip?: ItemActionEvent;
  onUse?: ItemActionEvent;
  onTransfer?: ItemActionSharedEvent;
  onDestroy?: ItemActionEvent;
};

/** Mutable flags describing what may currently be done with an item. */
type ItemProperties = {
  equippable: boolean;
  equipped: boolean;
  destroyable: boolean;
  usable: boolean;
};

/**
 * Anything that can hold items — a {@link ICharacter} inventory or a {@link ILoot}
 * container. Holders expose the primitives the item-transfer machinery relies on
 * to move items in and out.
 */
export interface IItemHolder {
  /** Discriminates the concrete holder kind. */
  readonly holderKind: "character" | "loot";
  /** Whether the holder has a free slot for another item. */
  hasRoomForItem(): boolean;
  /** Places `item` into the holder and claims ownership of it. */
  receiveItem(item: IItem): void;
  /** Removes `item` from the holder without re-homing it. */
  relinquishItem(item: IItem): void;
}

/** Concrete holder types an item can belong to. */
export type ItemHolder = ICharacter | ILoot;

/**
 * Symbol-keyed method used to (re)assign an item's holder.
 *
 * Re-pointing an item's holder is funnelled through this symbol so external code
 * cannot reassign `heldBy` directly (the public setter throws). Only a holder's
 * `receiveItem` should call it.
 */
export const CLAIM = Symbol("claimItem");

/**
 * Symbol key under which an item exposes its current holder.
 *
 * Using a Symbol keeps the key off `Object.keys` and the value off
 * `Object.values`, so the back-reference does not leak through enumeration.
 */
export const HELD_BY = Symbol.for("heldBy");

/**
 * A game item: a typed, craftable object that lives in a holder's inventory and
 * can be picked up, equipped, used, transferred, or destroyed via {@link IItem.actions}.
 */
export interface IItem {
  id: ItemId;
  name: string;
  type: ItemType;
  recipe: Recipe;
  modifier: number;
  properties: ItemProperties;
  stat: StatType;
  /** For keys only: the shared code matched by a scene/lock gate. */
  readonly keyCode?: string;
  /** For keys only: whether spending the key (consumeKey) is expected on use. */
  readonly consumeOnUse?: boolean;
  /** The item's current holder, or `null` when unheld. See {@link HELD_BY}. */
  readonly [HELD_BY]: ItemHolder | null;
  /** Reassigns the item's holder; for holder internals only. See {@link CLAIM}. */
  [CLAIM](holder: ItemHolder | null): void;
  /** Bound interaction handlers (pick up, equip, use, transfer, destroy, …). */
  actions: ItemActions;
}

/**
 * Default {@link IItem} implementation.
 *
 * The constructor wraps the caller-supplied {@link ItemActions} so that each
 * action enforces its preconditions, updates item state (e.g. the `equipped`
 * flag), and fires the matching {@link ItemEvents} hook. The equip/unequip/use/
 * transfer/destroy actions are no-ops while the item is held by a loot box
 * rather than a character.
 */
export class Item implements IItem {
  id: ItemId;
  name: string;
  type: ItemType;
  recipe: Recipe;
  modifier: number;
  stat: StatType;
  properties: ItemProperties;
  actions: ItemActions;
  readonly keyCode?: string;
  readonly consumeOnUse?: boolean;

  #heldBy: ItemHolder | null = null;

  get [HELD_BY]() {
    return this.#heldBy;
  }

  /**
   * Guards against direct reassignment of the holder.
   * @throws {@link ProceduralViolation} always — use {@link CLAIM} instead.
   */
  set heldBy(_value: ItemHolder | null) {
    throw new ProceduralViolation("Cannot set 'heldBy' directly!");
  }

  [CLAIM](holder: ItemHolder | null) {
    this.#heldBy = holder;
  }

  // The character-only item actions (equip/unequip/use/transfer/destroy) operate
  // only while a character holds the item; box-held items make them no-ops.
  #characterHolder(): ICharacter | null {
    return this.#heldBy?.holderKind === "character" ? this.#heldBy : null;
  }

  /**
   * @param descriptor - The item's intrinsic data.
   * @param descriptor.type - Item category (weapon, armor, …).
   * @param descriptor.recipe - Component makeup used for crafting/destruction.
   * @param descriptor.modifier - Strength applied when the item affects `stat`.
   * @param descriptor.stat - The {@link StatType} this item acts on.
   * @param descriptor.name - Display name.
   * @param properties - Initial mutable flags (equippable, equipped, …).
   * @param actions - Core behaviour for each interaction; wrapped on construction.
   * @param events - Observer hooks fired after the matching action runs.
   */
  constructor(
    {
      type,
      recipe,
      modifier,
      stat,
      name,
      keyCode,
      consumeOnUse,
    }: {
      type: ItemType;
      recipe: Recipe;
      modifier: number;
      stat: StatType;
      name: string;
      keyCode?: string;
      consumeOnUse?: boolean;
    },
    properties: ItemProperties,
    actions: ItemActions,
    events: ItemEvents,
  ) {
    this.id = uuid() as ItemId;
    this.name = name;
    this.type = type;
    this.recipe = recipe;
    this.modifier = modifier;
    this.stat = stat;
    this.properties = properties;
    this.keyCode = keyCode;
    this.consumeOnUse = consumeOnUse;

    this.actions = {
      [ItemAction.PickUp]: (c) => {
        actions[ItemAction.PickUp](c);
        events.onPickUp(c);
      },
      [ItemAction.Equip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Equip](holder);
        this.properties.equipped = true;
        events.onEquip?.(holder);
      },
      [ItemAction.Unequip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Unequip](holder);
        this.properties.equipped = false;
        events.onUnequip?.(holder);
      },
      [ItemAction.Transfer]: (_c, cc) => {
        const holder = this.#characterHolder();
        if (!holder) return;
        if (!cc.hasRoomForItem()) {
          throw new ProceduralViolation(
            "Attempted to transfer an item, but the recipient has no free inventory slots",
          );
        }
        actions[ItemAction.Transfer](holder, cc);
        events.onTransfer?.(holder, cc);
        holder.removeFromInventory(this);
        // receiveItem deposits the item into the recipient's inventory and
        // re-points heldBy through CLAIM (no direct #heldBy write).
        cc.receiveItem(this);
      },
      [ItemAction.Use]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Use](holder);
        events.onUse?.(holder);
        holder.removeFromInventory(this);
      },
      [ItemAction.Destroy]: () => {
        const holder = this.#characterHolder();
        if (!holder) return null;
        // A non-destroyable item (e.g. a key) cannot be broken down.
        if (!this.properties.destroyable) return null;
        const components = actions[ItemAction.Destroy]();
        events.onDestroy?.(holder, components);
        return components;
      },
    };
  }
}

/** A holder's item store: a fixed number of `slots` and the `items` filling them. */
export type Inventory = {
  slots: number;
  items: IItem[];
};

/**
 * Builds a key {@link Item}: a story-progression item that never occupies an
 * inventory slot, cannot be destroyed, and is matched to gates by its
 * {@link IItem.keyCode}. All key invariants are fixed here so callers cannot
 * accidentally create a destroyable or equippable key.
 *
 * @param descriptor - The key's display `name`, its shared `keyCode`, and
 *   whether using it is expected to consume it (`consumeOnUse`).
 * @returns A new key item (`type: "key"`, `destroyable: false`).
 */
export function createKey({
  name,
  keyCode,
  consumeOnUse,
}: {
  name: string;
  keyCode: string;
  consumeOnUse: boolean;
}): Item {
  return new Item(
    {
      type: ItemType.Key,
      // recipe/modifier/stat are required by the Item constructor but unused for keys.
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name,
      keyCode,
      consumeOnUse,
    },
    { equippable: false, equipped: false, destroyable: false, usable: false },
    {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
    { onPickUp: () => {} },
  );
}
