import type { Brand } from "../brand";
import { ICampaign } from "../campaign";
import { IItem, Inventory } from "../inventory";
import { IRoom } from "../room";
import { Status, StatusMatrix } from "../status";

import { generateId, ProceduralViolation } from "../util";
import { CharacterEvents, ICharacterEvents } from "./events";
import { MitigatorStatType, Stats, StatType } from "./stats";

export type CharacterId = Brand<string, "CharacterId">;

export interface ICharacter {
  // ### Properties
  id: CharacterId;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  readonly isActionMap: WeakMap<Function, boolean>;

  get campaign(): ICampaign;
  get currentRoom(): IRoom | null;
  get inventory(): Inventory;
  get isNormal(): boolean;
  get status(): Status[];

  // ### Methods
  addToInventory: (item: IItem | IItem[]) => void;
  endTurn: () => void;
  move: (room: IRoom) => void;
  removeFromInventory: (item: IItem) => void;
  recordAction: (callingFn: Function) => void;
  startTurn: () => void;
  takeDamage: (attackStrength: number, attackStat?: StatType) => void;

  // ### Events
  events: ICharacterEvents;
}

export class Character implements ICharacter {
  // Public Properties
  events: ICharacterEvents;
  id: CharacterId;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  readonly isActionMap: WeakMap<Function, boolean> = new WeakMap<
    Function,
    boolean
  >();

  // Private Properties
  #campaign: ICampaign;
  #currentRoom: IRoom | null = null;
  #inventory: Inventory;
  #status: StatusMatrix;
  protected actionsThisRound: number;

  // Public Getters
  get campaign() {
    return this.#campaign;
  }

  get currentRoom() {
    return this.#currentRoom;
  }

  get inventory() {
    return this.#inventory;
  }

  get isNormal() {
    return this.#status.values().every((val) => !!val);
  }

  get status() {
    return this.#status.entries().reduce((accumulator, [status, value]) => {
      if (value) {
        accumulator.push(status);
      }
      return accumulator;
    }, [] as Status[]);
  }

  // Private Methods
  #resetStatuses() {
    this.#status.set(Status.Confused, false);
    this.#status.set(Status.Fear, false);
    this.#status.set(Status.KO, false);
    this.#status.set(Status.Panic, false);
  }

  #resolveStatuses() {
    if (this.stats[StatType.Health] <= 0) {
      this.stats[StatType.Health] = 0;
      this.#status.set(Status.KO, true);
    } else {
      this.#status.set(Status.KO, false);
    }

    if (this.stats[StatType.Sanity] <= 0) {
      this.stats[StatType.Sanity] = 0;

      this.#status.set(Status.Panic, true);
      this.#status.set(Status.Fear, false);
    } else if (this.stats[StatType.Sanity] < 5) {
      this.#status.set(Status.Panic, false);
      this.#status.set(Status.Fear, true);
    } else {
      this.#status.set(Status.Panic, false);
      this.#status.set(Status.Fear, false);
    }

    if (this.stats[StatType.Energy] <= 0) {
      this.stats[StatType.Energy] = 0;
      this.#status.set(Status.Confused, true);
    } else if (this.stats[StatType.Energy] > 1) {
      this.#status.set(Status.Confused, false);
    }
  }

  #canAddToInventory() {
    return this.#inventory.items.length < this.#inventory.slots;
  }

  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
  ) {
    this.id = generateId<CharacterId>();
    this.name = name;
    this.stats = stats;
    this.events = new CharacterEvents(this);
    this.actionsPerRound = actionsPerRound;
    this.actionsThisRound = 0;

    this.#inventory = { slots: inventorySlots, items: [] };
    this.#campaign = campaign;
    this.#status = new Map<Status, boolean>();
    this.#resetStatuses();

    this.isActionMap.set(this.addToInventory, true);
    this.isActionMap.set(this.removeFromInventory, true);
  }

  recordAction(callingFn: Function) {
    if (this.isActionMap.get(callingFn)) {
      this.actionsThisRound = this.actionsThisRound + 1;
    }
    if (this.actionsThisRound === this.actionsPerRound) {
      this.endTurn();
    }
  }

  addToInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const item of items) {
      if (this.#canAddToInventory()) {
        this.#inventory.items.push(item);
        item.actions.pickUp(this);
      } else {
        throw new ProceduralViolation(
          "Attempted to add to inventory, but character doesn't have enough slots!",
        );
      }
    }
    this.recordAction(this.addToInventory);
  }

  removeFromInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const item of items) {
      let removed = false;
      this.#inventory.items = this.#inventory.items.reduce(
        (accumulator, currentItem) => {
          if (currentItem.id === item.id) {
            removed = true;
          } else if (currentItem.id !== item.id) {
            accumulator.push(currentItem);
          }
          return accumulator;
        },
        [] as IItem[],
      );
      if (!removed) {
        throw new ProceduralViolation(
          "Attempted to remove an item from inventory, but the item was not in the character's inventory!",
        );
      }
    }
    this.recordAction(this.removeFromInventory);
  }

  takeDamage(attackStrength: number, attackStat: StatType = StatType.Health) {
    const finalAttackStrength =
      attackStrength * ((10 - this.stats[MitigatorStatType[attackStat]]) * 0.2);

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;

    this.#resolveStatuses();
    this.recordAction(this.takeDamage);
  }

  move(room: IRoom) {
    if (this.#currentRoom) {
      this.#currentRoom.exitRoom(this);
    }
    this.#currentRoom = room;
    room.enterRoom(this);
    this.recordAction(this.move);
  }

  endTurn() {
    this.events.onTurnEnd();
    this.#resolveStatuses();
  }

  startTurn() {
    this.actionsThisRound = 0;
    this.events.onTurnStart();
    this.#resolveStatuses();
  }
}
