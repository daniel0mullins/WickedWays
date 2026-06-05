import { Brand } from "./brand";
import type { ICharacter } from "./character/character";
import type { ILoot } from "./loot";
import type { RequireAtLeastOne } from "type-fest";
import { v4 as uuid } from "uuid";
import { StatType } from "./character/stats";
import { ProceduralViolation } from "./util";

const ItemType = {
  Consumable: "consumable",
  Armor: "armor",
  Weapon: "weapon",
  Throwable: "throwable",
} as const;

export type ItemId = Brand<string, "ItemId">;
type ItemType = (typeof ItemType)[keyof typeof ItemType];

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

type Recipe = RequireAtLeastOne<{
  [k in ItemComponentType]: number;
}>;

type ItemActionEvent = <C extends ICharacter>(
  c: C,
  components?: ItemComponentType[] | null,
) => void;

type ItemActionSharedEvent = <C extends ICharacter, CC extends ICharacter>(
  c: C,
  cc: CC,
) => void;

const ItemAction = {
  PickUp: "pickUp",
  Equip: "equip",
  Unequip: "unequip",
  Transfer: "transfer",
  Destroy: "destroy",
  Use: "use",
} as const;

type ItemActions = {
  [ItemAction.PickUp]: ItemActionEvent;
  [ItemAction.Equip]: ItemActionEvent;
  [ItemAction.Unequip]: ItemActionEvent;
  [ItemAction.Transfer]: ItemActionSharedEvent;
  [ItemAction.Use]: ItemActionEvent;
  [ItemAction.Destroy]: () => ItemComponentType[] | null;
};

type ItemEvents = {
  onPickUp: ItemActionEvent;
  onEquip?: ItemActionEvent;
  onUnequip?: ItemActionEvent;
  onUse?: ItemActionEvent;
  onTransfer?: ItemActionSharedEvent;
  onDestroy?: ItemActionEvent;
};

type ItemProperties = {
  equippable: boolean;
  equipped: boolean;
  destroyable: boolean;
  usable: boolean;
};

export interface IItemHolder {
  readonly holderKind: "character" | "loot";
  hasRoomForItem(): boolean;
  receiveItem(item: IItem): void;
  relinquishItem(item: IItem): void;
}

export type ItemHolder = ICharacter | ILoot;

// Re-pointing an item's holder is funnelled through this symbol-keyed method so
// external code cannot reassign `heldBy` directly (the public setter throws).
// Only a holder's `receiveItem` should call it.
export const CLAIM = Symbol("claimItem");

// Using a Symbol so Object.keys does not leak the key and Object.values does not leak the value
export const HELD_BY = Symbol.for("heldBy");

export interface IItem {
  id: ItemId;
  type: ItemType;
  recipe: Recipe;
  modifier: number;
  properties: ItemProperties;
  stat: StatType;
  readonly [HELD_BY]: ItemHolder | null;
  [CLAIM](holder: ItemHolder | null): void;
  actions: ItemActions;
}

export class Item implements IItem {
  id: ItemId;
  type: ItemType;
  recipe: Recipe;
  modifier: number;
  stat: StatType;
  properties: ItemProperties;
  actions: ItemActions;

  #heldBy: ItemHolder | null = null;

  get [HELD_BY]() {
    return this.#heldBy;
  }

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

  constructor(
    {
      type,
      recipe,
      modifier,
      stat,
    }: {
      type: ItemType;
      recipe: Recipe;
      modifier: number;
      stat: StatType;
    },
    properties: ItemProperties,
    actions: ItemActions,
    events: ItemEvents,
  ) {
    this.id = uuid() as ItemId;
    this.type = type;
    this.recipe = recipe;
    this.modifier = modifier;
    this.stat = stat;
    this.properties = properties;

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
        actions[ItemAction.Transfer](holder, cc);
        events.onTransfer?.(holder, cc);
        holder.removeFromInventory(this);
        this.#heldBy = cc;
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
        const components = actions[ItemAction.Destroy]();
        events.onDestroy?.(holder, components);
        return components;
      },
    };
  }
}

export type Inventory = {
  slots: number;
  items: IItem[];
};
