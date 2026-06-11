import { Brand } from "./brand";
import type { ICharacter } from "./character/character";
import type { ILoot } from "./loot";
import type { RequireAtLeastOne } from "type-fest";
import { v4 as uuid } from "uuid";
import { StatType } from "./character/stats";
import { ProceduralViolation } from "./util";
import type { CraftingRecipe } from "./crafting";
import type { SlotKind } from "./equipment";
import { Status } from "./status";

/** The kinds of item the engine recognises. */
const ItemType = {
  Consumable: "consumable",
  Armor: "armor",
  Weapon: "weapon",
  Throwable: "throwable",
  Accessory: "accessory",
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

/** A quantity of raw materials by component type; the currency of the party pool. */
export type MaterialMap = Partial<Record<ItemComponentType, number>>;

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
 * Symbol-keyed method that adds raw materials to the party's pool.
 *
 * Raw deposits are funnelled through this symbol so author/scene code cannot mint
 * materials at will (which would defeat anti-farming). Only engine internals — the
 * Item Destroy wrapper, {@link Character.harvest}, and {@link Campaign.claimMaterials}
 * — call it. There is no public "add materials" method.
 */
export const DEPOSIT_MATERIALS = Symbol("depositMaterials");

/**
 * Symbol-keyed setter for an item's current durability.
 *
 * Durability is read publicly but written only through this symbol, so wear
 * (combat) and repair are the sole mutation paths. The setter clamps to
 * `[0, maxDurability]`; on an item with no durability it is a no-op. Follows the
 * same privileged-mutator pattern as {@link CLAIM} and {@link DEPOSIT_MATERIALS}.
 */
export const SET_DURABILITY = Symbol("setDurability");

/**
 * Symbol-keyed low-level equip/unequip. They run the item's author equip/unequip
 * behavior, toggle `properties.equipped`, and fire the matching event — the
 * terminal step, with no slot validation. Only {@link Character.equip}/`unequip`
 * and the item's own action wrapper call them. Same privileged-mutator pattern as
 * {@link CLAIM} and {@link SET_DURABILITY}.
 */
export const EQUIP = Symbol("equipItem");
export const UNEQUIP = Symbol("unequipItem");

/**
 * Symbol-keyed seam used to grant timed status immunity to a character holder.
 * Only the item `Use` path calls it, keeping grants unforgeable by stray code.
 */
export const GRANT_IMMUNITY = Symbol("GRANT_IMMUNITY");

/**
 * Symbol-keyed seam the item `Use` path uses to consume the item. It removes the
 * item with affliction gating suppressed (use is the always-allowed escape hatch)
 * while preserving the existing drop record and budget tick.
 */
export const CONSUME_VIA_USE = Symbol("CONSUME_VIA_USE");

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
  /** Max durability for equipment that wears; absent for items without durability. */
  readonly maxDurability?: number;
  /** Current durability in `[0, maxDurability]`; absent when the item has no durability. */
  readonly durability?: number;
  /** True when the item has durability and it has reached 0. */
  readonly isBroken: boolean;
  /** Sets durability, clamped to `[0, maxDurability]`; for combat/repair internals only. See {@link SET_DURABILITY}. */
  [SET_DURABILITY](value: number): void;
  /** Low-level equip: runs behavior, sets `equipped`, fires `onEquip`. See {@link EQUIP}. */
  [EQUIP](holder: ICharacter): void;
  /** Low-level unequip: runs behavior, clears `equipped`, fires `onUnequip`. See {@link UNEQUIP}. */
  [UNEQUIP](holder: ICharacter): void;
  /** The kind of slot this item equips into; absent ⇒ not slot-equippable. */
  readonly slot?: SlotKind;
  /** Weapons only: occupies both hand slots when equipped. */
  readonly twoHanded?: boolean;
  /** A recipe this item imparts to the party when picked up. */
  readonly teaches?: CraftingRecipe;
  /** Statuses this item confers immunity to while equipped (passive immunity). */
  readonly immunities?: Status[];
  /** On use, grants timed immunity to these statuses for `turns` of the holder's turns. */
  readonly grantsImmunity?: { statuses: Status[]; turns: number };
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
  readonly teaches?: CraftingRecipe;
  readonly immunities?: Status[];
  readonly grantsImmunity?: { statuses: Status[]; turns: number };
  readonly maxDurability?: number;
  readonly slot?: SlotKind;
  readonly twoHanded?: boolean;
  #durability?: number;
  // The raw equip/unequip behavior and events, captured from the constructor so
  // the class-level {@link EQUIP}/{@link UNEQUIP} methods can reach them (unlike
  // the other action wrappers, which close over the constructor params inline).
  #equipBehavior: ItemActionEvent;
  #unequipBehavior: ItemActionEvent;
  #onEquip?: ItemActionEvent;
  #onUnequip?: ItemActionEvent;

  get durability(): number | undefined {
    return this.#durability;
  }

  get isBroken(): boolean {
    return this.maxDurability !== undefined && this.#durability === 0;
  }

  [SET_DURABILITY](value: number) {
    // No durability to mutate. (A degenerate `maxDurability: 0` author error is
    // tolerated, not guarded: it clamps every write to 0, i.e. always-broken.)
    if (this.maxDurability === undefined) return;
    this.#durability = Math.max(0, Math.min(this.maxDurability, value));
  }

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

  // The terminal equip/unequip step: run the raw author behavior, toggle the
  // flag, fire the event. Calls #equipBehavior directly (never actions.equip), so
  // Character.equip can route a slotted item through validation and finish here
  // without looping back into the action wrapper.
  [EQUIP](holder: ICharacter) {
    this.#equipBehavior(holder);
    this.properties.equipped = true;
    this.#onEquip?.(holder);
  }

  [UNEQUIP](holder: ICharacter) {
    this.#unequipBehavior(holder);
    this.properties.equipped = false;
    this.#onUnequip?.(holder);
  }

  /**
   * @param descriptor - The item's intrinsic data.
   * @param descriptor.type - Item category (weapon, armor, …).
   * @param descriptor.recipe - Component makeup used for crafting/destruction.
   * @param descriptor.modifier - Strength applied when the item affects `stat`.
   * @param descriptor.stat - The {@link StatType} this item acts on.
   * @param descriptor.name - Display name.
   * @param descriptor.keyCode - Shared lock/gate code (keys only).
   * @param descriptor.consumeOnUse - Whether using the key spends it (keys only).
   * @param descriptor.teaches - Recipe this item imparts to the party when picked up.
   * @param descriptor.maxDurability - Max durability for equipment that wears (optional).
   * @param descriptor.durability - Starting durability; defaults to `maxDurability`.
   * @param descriptor.slot - The {@link SlotKind} this item equips into (optional).
   * @param descriptor.twoHanded - Weapons only: occupies both hands when equipped.
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
      teaches,
      immunities,
      grantsImmunity,
      maxDurability,
      durability,
      slot,
      twoHanded,
    }: {
      type: ItemType;
      recipe: Recipe;
      modifier: number;
      stat: StatType;
      name: string;
      keyCode?: string;
      consumeOnUse?: boolean;
      teaches?: CraftingRecipe;
      immunities?: Status[];
      grantsImmunity?: { statuses: Status[]; turns: number };
      maxDurability?: number;
      durability?: number;
      slot?: SlotKind;
      twoHanded?: boolean;
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
    this.teaches = teaches;
    this.immunities = immunities;
    this.grantsImmunity = grantsImmunity;
    this.maxDurability = maxDurability;
    this.slot = slot;
    this.twoHanded = twoHanded;
    this.#durability =
      maxDurability === undefined
        ? undefined
        : Math.max(0, Math.min(maxDurability, durability ?? maxDurability));
    this.#equipBehavior = actions[ItemAction.Equip];
    this.#unequipBehavior = actions[ItemAction.Unequip];
    this.#onEquip = events.onEquip;
    this.#onUnequip = events.onUnequip;

    this.actions = {
      [ItemAction.PickUp]: (c) => {
        actions[ItemAction.PickUp](c);
        events.onPickUp(c);
      },
      // A slotted item routes through Character.equip so slot capacity is
      // enforced even via the item's own action (no bypass); the validated path
      // calls back into [EQUIP] to finish. Slotless legacy equippables toggle
      // directly here.
      [ItemAction.Equip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        if (this.slot !== undefined) {
          holder.equip(this);
          return;
        }
        this[EQUIP](holder);
      },
      [ItemAction.Unequip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        if (this.slot !== undefined) {
          holder.unequip(this);
          return;
        }
        this[UNEQUIP](holder);
      },
      [ItemAction.Transfer]: (_c, cc) => {
        // Keys are transfer-only via Character.transferKey; a key reaching this
        // generic path is rejected downstream by holder.removeFromInventory.
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
        // `use` is the always-allowed escape hatch UNDER Panic/Fear/Confused, but
        // a KO'd character can do nothing at all — including use an item.
        if (holder.status.includes(Status.KO)) {
          throw new ProceduralViolation("Cannot use items while KO'd.");
        }
        actions[ItemAction.Use](holder);
        events.onUse?.(holder);
        if (this.grantsImmunity) {
          holder[GRANT_IMMUNITY](
            this.grantsImmunity.statuses,
            this.grantsImmunity.turns,
          );
        }
        // Consume via the gate-suppressed seam so a Panicked/Confused holder can
        // still use the item; this still records the drop and ticks the budget.
        holder[CONSUME_VIA_USE](this);
      },
      [ItemAction.Destroy]: () => {
        const holder = this.#characterHolder();
        if (!holder) return null;
        // A non-destroyable item (e.g. a key) cannot be broken down.
        if (!this.properties.destroyable) return null;
        const components = actions[ItemAction.Destroy]();
        // Scrapping returns the item's makeup to the party pool; `recipe` is the
        // single source of truth for both scrap-yield and (later) craft-cost.
        holder.campaign[DEPOSIT_MATERIALS](this.recipe);
        events.onDestroy?.(holder, components);
        // The item is consumed: pull it from the holder and unhome it so it does
        // not linger as a ghost. Removal is silent — relinquishItem, not
        // removeFromInventory — so destroying logs no "drop" and stays free.
        holder.relinquishItem(this);
        this[CLAIM](null);
        return components;
      },
    };
  }
}

/** A holder's item store: `slots`/`items` for normal items, plus a free `keys` keyring. */
export type Inventory = {
  slots: number;
  items: IItem[];
  keys: IItem[];
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
