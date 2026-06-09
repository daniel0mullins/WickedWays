import type { Brand } from "../brand";
import { ICampaign } from "../campaign";
import { CLAIM, IItem, IItemHolder, Inventory } from "../inventory";
import { IRoom } from "../room";
import { Status, StatusMatrix } from "../status";

import { generateId, ProceduralViolation } from "../util";
import { CharacterEvents, ICharacterEvents } from "./events";
import type { ActionDetail, ActionHistoryEntry } from "./history";
import { MitigatorStatType, Stats, StatType } from "./stats";

export type CharacterId = Brand<string, "CharacterId">;

// Damage mitigation: a mitigating stat of MAX_STAT fully absorbs the hit, while
// a mitigator of 0 doubles it. Each point of the mitigating stat removes
// MITIGATION_PER_POINT of the incoming damage multiplier.
const MAX_STAT = 10;
const MITIGATION_PER_POINT = 0.2;

// Any callable, used purely as an identity key in the action-tracking maps.
// Preferred over the unsafe built-in `Function` type.
export type ActionFn = (...args: never[]) => unknown;

export interface ICharacter extends IItemHolder {
  // ### Properties
  readonly holderKind: "character";
  id: CharacterId;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  readonly isActionMap: WeakMap<ActionFn, boolean>;

  get campaign(): ICampaign;
  get currentRoom(): IRoom | null;
  get history(): readonly ActionHistoryEntry[];
  get inventory(): Inventory;
  get isNormal(): boolean;
  get status(): Status[];

  // ### Methods
  addToInventory: (item: IItem | IItem[]) => void;
  endTurn: () => void;
  move: (room: IRoom) => void;
  removeFromInventory: (item: IItem) => void;
  recordAction: (callingFn: ActionFn, detail: ActionDetail) => void;
  startTurn: () => void;
  takeDamage: (attackStrength: number, attackStat?: StatType) => void;

  // ### Events
  events: ICharacterEvents;
}

export class Character implements ICharacter {
  // Public Properties
  readonly holderKind = "character" as const;
  events: ICharacterEvents;
  id: CharacterId;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  readonly isActionMap: WeakMap<ActionFn, boolean> = new WeakMap<
    ActionFn,
    boolean
  >();

  // Private Properties
  #campaign: ICampaign;
  #currentRoom: IRoom | null = null;
  #history: ActionHistoryEntry[] = [];
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

  get history(): readonly ActionHistoryEntry[] {
    return [...this.#history];
  }

  get inventory() {
    return this.#inventory;
  }

  get isNormal() {
    return this.#status.values().every((val) => !val);
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

  hasRoomForItem() {
    return this.#inventory.items.length < this.#inventory.slots;
  }

  receiveItem(item: IItem) {
    this.#inventory.items.push(item);
    item[CLAIM](this);
  }

  relinquishItem(item: IItem) {
    const index = this.#inventory.items.findIndex(
      (current) => current.id === item.id,
    );
    if (index !== -1) {
      this.#inventory.items.splice(index, 1);
    }
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

  recordAction(callingFn: ActionFn, detail: ActionDetail) {
    this.#history.push({
      ...detail,
      round: this.campaign.round,
    } as ActionHistoryEntry);

    if (this.isActionMap.get(callingFn)) {
      this.actionsThisRound = this.actionsThisRound + 1;
    }
    if (this.actionsThisRound === this.actionsPerRound) {
      this.endTurn();
    }
  }

  addToInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const current of items) {
      if (this.hasRoomForItem()) {
        this.receiveItem(current);
        current.actions.pickUp(this);
      } else {
        throw new ProceduralViolation(
          "Attempted to add to inventory, but character doesn't have enough slots!",
        );
      }
    }
    this.recordAction(this.addToInventory, {
      kind: "pickUp",
      items: items.map((i) => ({ id: i.id, name: i.name })),
    });
  }

  removeFromInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const current of items) {
      const held = this.#inventory.items.some((i) => i.id === current.id);
      if (!held) {
        throw new ProceduralViolation(
          "Attempted to remove an item from inventory, but the item was not in the character's inventory!",
        );
      }
      this.relinquishItem(current);
    }
    this.recordAction(this.removeFromInventory, {
      kind: "drop",
      items: items.map((i) => ({ id: i.id, name: i.name })),
    });
  }

  takeDamage(attackStrength: number, attackStat: StatType = StatType.Health) {
    const mitigator = this.stats[MitigatorStatType[attackStat]];
    const damageMultiplier = (MAX_STAT - mitigator) * MITIGATION_PER_POINT;
    const finalAttackStrength = attackStrength * damageMultiplier;

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;

    this.#resolveStatuses();
    this.recordAction(this.takeDamage, {
      kind: "takeDamage",
      amount: finalAttackStrength,
      stat: attackStat,
    });
  }

  move(room: IRoom) {
    if (this.#currentRoom) {
      this.#currentRoom.exitRoom(this);
    }
    this.#currentRoom = room;
    room.enterRoom(this);
    this.recordAction(this.move, {
      kind: "move",
      room: { id: room.id, name: room.name },
    });
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
