import { Brand } from "./brand";
import type { ICharacter } from "./character/character";
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

// Using a Symbol so Object.keys does not leak the key and Object.values does not leak the value
const HELD_BY = Symbol.for("heldBy");

export interface IItem {
  id: ItemId;
  type: ItemType;
  recipe: Recipe;
  modifier: number;
  properties: ItemProperties;
  stat: StatType;
  readonly [HELD_BY]: ICharacter | null;
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

  #heldBy: ICharacter | null = null;

  get [HELD_BY]() {
    return this.#heldBy;
  }

  set heldBy(_value: ICharacter | null) {
    throw new ProceduralViolation("Cannot set 'heldBy' directly!");
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
        this.#heldBy = c;
        actions[ItemAction.PickUp](c);
        events.onPickUp(c);
      },
      [ItemAction.Equip]: () => {
        if (!this.#heldBy) return;
        actions[ItemAction.Equip](this.#heldBy);
        this.properties.equipped = true;
        events.onEquip?.(this.#heldBy);
      },
      [ItemAction.Unequip]: () => {
        if (!this.#heldBy) return;
        actions[ItemAction.Unequip](this.#heldBy);
        this.properties.equipped = false;
        events.onUnequip?.(this.#heldBy);
      },
      [ItemAction.Transfer]: (_c, cc) => {
        if (!this.#heldBy) return;
        actions[ItemAction.Transfer](this.#heldBy, cc);
        events.onTransfer?.(this.#heldBy, cc);
        this.#heldBy.removeFromInventory(this);
        this.#heldBy = cc;
      },
      [ItemAction.Use]: () => {
        if (!this.#heldBy) return;
        actions[ItemAction.Use](this.#heldBy);
        events.onUse?.(this.#heldBy);
        this.#heldBy.removeFromInventory(this);
      },
      [ItemAction.Destroy]: () => {
        if (!this.#heldBy) return null;
        const components = actions[ItemAction.Destroy]();
        events.onDestroy?.(this.#heldBy, components);
        return components;
      },
    };
  }
}

export type Inventory = {
  slots: number;
  items: IItem[];
};
