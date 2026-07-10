import { Brand } from "./brand";
import type { ICharacter } from "./character/character";
import type { ILoot } from "./loot";
import type { RequireAtLeastOne } from "type-fest";
import { v4 as uuid } from "uuid";
import { StatType } from "./character/stats";
export { StatType } from "./character/stats";
import { ProceduralViolation } from "./util";
import type { CraftingRecipe } from "./crafting";
import type { SlotKind } from "./equipment";
import { Status } from "./status";
import type { Presentation } from "./presentation";
import { HYDRATE, SERIALIZE } from "./serialization/symbols";
import type { ItemSnapshot } from "./serialization/types";
import type { HydrateContext } from "./serialization/context";

/** The kinds of item the engine recognises. */
export const ItemType = {
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
type ItemActionEvent = <Actor extends ICharacter>(
  c: Actor,
  components?: ItemComponentType[] | null,
) => void;

/** Item action callback acting between two characters (e.g. a transfer). */
type ItemActionSharedEvent = <Actor extends ICharacter, Recipient extends ICharacter>(
  c: Actor,
  cc: Recipient,
) => void;

/**
 * Author-supplied action behaviors (the {@link ItemActionsInput} passed to the
 * constructor) run with `this` bound to the item, so a behavior can read its own
 * item — e.g. a consumable that heals `this.modifier` of `this.stat`. The public
 * {@link Item.actions} wrappers are `this`-less (they close over the item), so
 * callers invoke them without binding.
 */
type BoundActionEvent = <Actor extends ICharacter>(
  this: IItem,
  c: Actor,
  components?: ItemComponentType[] | null,
) => void;
type BoundSharedEvent = <Actor extends ICharacter, Recipient extends ICharacter>(
  this: IItem,
  c: Actor,
  cc: Recipient,
) => void;

/** The interactions an item can be the subject of. */
export const ItemAction = {
  PickUp: "pickUp",
  Equip: "equip",
  Unequip: "unequip",
  Transfer: "transfer",
  Destroy: "destroy",
  Use: "use",
  Read: "read",
} as const;

/**
 * The core behaviour each action performs, supplied when an {@link Item} is
 * constructed. The `Item` wraps these and fires the matching {@link ItemEvents}
 * hook after each runs.
 */
export type ItemActions = {
  [ItemAction.PickUp]: ItemActionEvent;
  [ItemAction.Equip]: ItemActionEvent;
  [ItemAction.Unequip]: ItemActionEvent;
  [ItemAction.Transfer]: ItemActionSharedEvent;
  [ItemAction.Use]: ItemActionEvent;
  [ItemAction.Destroy]: () => ItemComponentType[] | null;
  /** Optional, non-consuming inspect behaviour run by {@link ICharacter.read}. */
  [ItemAction.Read]?: ItemActionEvent;
};

/**
 * The action behaviors supplied to the {@link Item} constructor. Same shape as
 * {@link ItemActions}, except each behavior runs with `this` bound to the item
 * (see {@link BoundActionEvent}). The constructor wraps these into the `this`-less
 * {@link ItemActions} exposed on {@link Item.actions}.
 */
export type ItemActionsInput = {
  [ItemAction.PickUp]: BoundActionEvent;
  [ItemAction.Equip]: BoundActionEvent;
  [ItemAction.Unequip]: BoundActionEvent;
  [ItemAction.Transfer]: BoundSharedEvent;
  [ItemAction.Use]: BoundActionEvent;
  [ItemAction.Destroy]: (this: IItem) => ItemComponentType[] | null;
  /** Optional, non-consuming inspect behaviour run by {@link ICharacter.read}. */
  [ItemAction.Read]?: BoundActionEvent;
};

/**
 * Optional observer hooks fired after the corresponding {@link ItemActions}
 * behaviour runs. Only `onPickUp` is required.
 */
export type ItemEvents = {
  onPickUp: ItemActionEvent;
  onEquip?: ItemActionEvent;
  onUnequip?: ItemActionEvent;
  onUse?: ItemActionEvent;
  onTransfer?: ItemActionSharedEvent;
  onDestroy?: ItemActionEvent;
  onRead?: ItemActionEvent;
};

/** Mutable flags describing what may currently be done with an item. */
export type ItemProperties = {
  equippable: boolean;
  equipped: boolean;
  destroyable: boolean;
  usable: boolean;
  /** Whether the item may be dropped. Absent ⇒ droppable; `false` marks a
   *  required item (e.g. a quest item) that must not be set down. */
  droppable?: boolean;
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
 * Symbol-keyed method that forces an item (including a key) into a {@link Loot}
 * box, bypassing the player-facing "no keys in loot" and capacity guards. Only
 * the mob defeat-drop path calls it. The caller must first relinquish the item
 * from its current holder — like {@link CLAIM}, this only claims, it does not
 * evict the prior holder.
 */
export const STASH_DROP = Symbol("stashDrop");

/**
 * Symbol-keyed method that wires a character into a room (sets current room and
 * occupancy) with no gating, history, or budget tick. Engine-internal: room
 * placement and encounter spawning call it.
 */
export const PLACE = Symbol("place");

/**
 * Symbol-keyed method that sets a mob's origin (`"room"` | `"campaign"`). Only
 * {@link Room.placeMob} and the {@link EncounterTable} spawn path call it.
 */
export const SET_ORIGIN = Symbol("setOrigin");

/**
 * Symbol-keyed method that adds a light source to a room's `lightSources`.
 * Only {@link Character.placeLight} and room authoring call it.
 */
export const ADD_LIGHT_SOURCE = Symbol("addLightSource");

/**
 * Symbol-keyed method that removes a light source from a room's `lightSources`.
 * Only {@link Character.takeLight} calls it.
 */
export const REMOVE_LIGHT_SOURCE = Symbol("removeLightSource");

/**
 * Symbol-keyed method that flips a character's `visible` flag (reversibly). Only
 * the mechanics `SetVisible` effect (an NPC that "disappears") calls it, keeping
 * visibility unforgeable by stray code — same discipline as the other seams.
 */
export const SET_VISIBLE = Symbol("setVisible");

/**
 * Symbol-keyed method that overwrites a character's per-instance NPC dialogue
 * state (the `once`-latch store the dialogue matcher reads/writes). Only the
 * dialogue oracle/host writes it, keeping the latch unforgeable — same discipline
 * as {@link SET_VISIBLE}.
 */
export const SET_NPC_STATE = Symbol("setNpcState");

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
  /** Registry key that maps this item to its factory; required for serialization of non-key items. */
  readonly behaviorKey?: string;
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
  /** Light sources only: when active (carried or placed) this item lights its room. */
  readonly emitsLight?: boolean;
  /** Evocative flavour/backstory text revealed on {@link ICharacter.read}, if any. */
  readonly lore?: string;
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
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
  /** Returns a plain-data snapshot suitable for persistence. See {@link SERIALIZE}. */
  [SERIALIZE](): ItemSnapshot;
}

/**
 * The immutable identity of an item, supplied to the {@link Item} constructor:
 * what kind of thing it is, what crafted it, and its optional behavioural traits
 * (durability, equip slot, light, immunities, serialization key, …).
 */
export interface ItemDescriptor {
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
  emitsLight?: boolean;
  presentation?: Presentation;
  behaviorKey?: string;
  /** Evocative flavour/backstory text revealed when the item is read (see {@link ICharacter.read}). */
  lore?: string;
}

/** Constructor options for an {@link Item}. */
export interface ItemOptions {
  /** Immutable descriptor (identity, type, durability, slot, etc.). */
  descriptor: ItemDescriptor;
  /** Initial mutable flags (equippable, equipped, …). */
  properties: ItemProperties;
  /** Core behaviour for each interaction; wrapped on construction. Each behavior
   *  runs with `this` bound to the item (see {@link ItemActionsInput}). */
  actions: ItemActionsInput;
  /** Observer hooks fired after the matching action runs. */
  events: ItemEvents;
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
  /** Registry key that maps this item to its factory; required for serialization of non-key items. */
  behaviorKey?: string;
  readonly keyCode?: string;
  readonly consumeOnUse?: boolean;
  readonly teaches?: CraftingRecipe;
  readonly immunities?: Status[];
  readonly grantsImmunity?: { statuses: Status[]; turns: number };
  readonly maxDurability?: number;
  readonly slot?: SlotKind;
  readonly twoHanded?: boolean;
  readonly emitsLight?: boolean;
  readonly lore?: string;
  #durability?: number;
  #presentation?: Presentation;
  // The raw equip/unequip behavior and events, captured from the constructor so
  // the class-level {@link EQUIP}/{@link UNEQUIP} methods can reach them (unlike
  // the other action wrappers, which close over the constructor params inline).
  #equipBehavior: BoundActionEvent;
  #unequipBehavior: BoundActionEvent;
  #onEquip?: ItemActionEvent;
  #onUnequip?: ItemActionEvent;

  get durability(): number | undefined {
    return this.#durability;
  }

  get isBroken(): boolean {
    return this.maxDurability !== undefined && this.#durability === 0;
  }

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }

  [SET_DURABILITY](value: number) {
    // No durability to mutate. (A degenerate `maxDurability: 0` author error is
    // tolerated, not guarded: it clamps every write to 0, i.e. always-broken.)
    if (this.maxDurability === undefined) return;
    this.#durability = Math.max(0, Math.min(this.maxDurability, value));
  }

  [SERIALIZE](): ItemSnapshot {
    if (this.type === ItemType.Key) {
      return {
        kind: "key",
        id: this.id,
        name: this.name,
        keyCode: this.keyCode ?? "",
        consumeOnUse: this.consumeOnUse ?? false,
      };
    }
    if (this.behaviorKey === undefined) {
      throw new ProceduralViolation(
        `Item '${this.name}' (${this.id}) cannot be serialized: no behaviorKey. Register a factory and pass behaviorKey.`,
      );
    }
    return {
      kind: "item",
      id: this.id,
      behaviorKey: this.behaviorKey,
      ...(this.durability !== undefined ? { durability: this.durability } : {}),
      modifier: this.modifier,
    };
  }

  /** In-place restore of mutable item state. Keys are immutable post-construction. */
  [HYDRATE](data: ItemSnapshot): void {
    if (data.kind === "key") return;
    this.behaviorKey = data.behaviorKey;
    if (data.durability !== undefined) this[SET_DURABILITY](data.durability);
    this.modifier = data.modifier;
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
    this.#equipBehavior.call(this, holder);
    this.properties.equipped = true;
    this.#onEquip?.(holder);
  }

  [UNEQUIP](holder: ICharacter) {
    this.#unequipBehavior.call(this, holder);
    this.properties.equipped = false;
    this.#onUnequip?.(holder);
  }

  /**
   * @param opts - See {@link ItemOptions}.
   * @param opts.descriptor - The item's intrinsic data.
   * @param opts.descriptor.type - Item category (weapon, armor, …).
   * @param opts.descriptor.recipe - Component makeup used for crafting/destruction.
   * @param opts.descriptor.modifier - Strength applied when the item affects `stat`.
   * @param opts.descriptor.stat - The {@link StatType} this item acts on.
   * @param opts.descriptor.name - Display name.
   * @param opts.descriptor.keyCode - Shared lock/gate code (keys only).
   * @param opts.descriptor.consumeOnUse - Whether using the key spends it (keys only).
   * @param opts.descriptor.teaches - Recipe this item imparts to the party when picked up.
   * @param opts.descriptor.maxDurability - Max durability for equipment that wears (optional).
   * @param opts.descriptor.durability - Starting durability; defaults to `maxDurability`.
   * @param opts.descriptor.slot - The {@link SlotKind} this item equips into (optional).
   * @param opts.descriptor.twoHanded - Weapons only: occupies both hands when equipped.
   * @param opts.descriptor.emitsLight - Light sources only: lights its room when active.
   * @param opts.descriptor.behaviorKey - Registry key used by the `CampaignRegistry` to
   *   restore this item's factory at deserialize time. Required for non-key items
   *   that must survive serialization; omit only for key items (`keyCode` set).
   * @param opts.properties - Initial mutable flags (equippable, equipped, …).
   * @param opts.actions - Core behaviour for each interaction; wrapped on construction.
   * @param opts.events - Observer hooks fired after the matching action runs.
   */
  constructor(opts: ItemOptions) {
    const { descriptor, properties, actions, events } = opts;
    const {
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
      emitsLight,
      presentation,
      behaviorKey,
      lore,
    } = descriptor;
    this.id = uuid() as ItemId;
    this.name = name;
    this.type = type;
    this.recipe = recipe;
    this.modifier = modifier;
    this.stat = stat;
    this.properties = properties;
    this.behaviorKey = behaviorKey;
    this.keyCode = keyCode;
    this.consumeOnUse = consumeOnUse;
    this.teaches = teaches;
    this.immunities = immunities;
    this.grantsImmunity = grantsImmunity;
    this.maxDurability = maxDurability;
    this.slot = slot;
    this.twoHanded = twoHanded;
    this.emitsLight = emitsLight;
    this.lore = lore;
    this.#presentation = presentation;
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
        actions[ItemAction.PickUp].call(this, c);
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
        actions[ItemAction.Transfer].call(this, holder, cc);
        events.onTransfer?.(holder, cc);
        holder.removeFromInventory(this);
        // receiveItem deposits the item into the recipient's inventory and
        // re-points heldBy through CLAIM (no direct #heldBy write).
        cc.receiveItem(this);
      },
      [ItemAction.Use]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        // A non-usable item cannot be used — using it must neither run author
        // behaviour nor consume the item (e.g. a story item like a journal).
        if (!this.properties.usable) {
          throw new ProceduralViolation(`The ${this.name} isn't something you can use.`);
        }
        // `use` is the always-allowed escape hatch UNDER Panic/Fear/Confused, but
        // a KO'd character can do nothing at all — including use an item.
        if (holder.status.includes(Status.KO)) {
          throw new ProceduralViolation("Cannot use items while KO'd.");
        }
        actions[ItemAction.Use].call(this, holder);
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
      // Reading is a passive inspection: it runs any author read behaviour and
      // fires onRead, but — unlike Use — never consumes the item. The lore text
      // itself is surfaced by Character.read through the cue seam.
      [ItemAction.Read]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Read]?.call(this, holder);
        events.onRead?.(holder);
      },
      [ItemAction.Destroy]: () => {
        const holder = this.#characterHolder();
        if (!holder) return null;
        // A non-destroyable item (e.g. a key) cannot be broken down.
        if (!this.properties.destroyable) return null;
        const components = actions[ItemAction.Destroy].call(this);
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
  return new Item({
    descriptor: {
      type: ItemType.Key,
      // recipe/modifier/stat are required by the Item constructor but unused for keys.
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name,
      keyCode,
      consumeOnUse,
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false },
    actions: {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
    events: { onPickUp: () => {} },
  });
}

/**
 * Reconstructs an {@link Item} from its {@link ItemSnapshot}.
 *
 * Keys are rebuilt via {@link createKey}; non-key items are rebuilt by calling
 * the registered factory from `ctx.registry`, then overlaying the mutable state
 * (durability, modifier) from the snapshot. The item's id is restored from the
 * snapshot and registered in `ctx` so that holder references can be wired in a
 * later pass.
 *
 * @throws {@link ProceduralViolation} if a non-key item's `behaviorKey` is not registered.
 */
export function hydrateItem(data: ItemSnapshot, ctx: HydrateContext): Item {
  let item: Item;
  if (data.kind === "key") {
    item = createKey({ name: data.name, keyCode: data.keyCode, consumeOnUse: data.consumeOnUse });
  } else {
    item = ctx.registry.item(data.behaviorKey)();
    item[HYDRATE](data);
  }
  item.id = data.id as ItemId;
  ctx.put(item.id, item);
  return item;
}
