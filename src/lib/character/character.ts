import type { Brand } from "../brand";
import { ICampaign } from "../campaign";
import { CLAIM, IItem, IItemHolder, Inventory } from "../inventory";
import { IRoom } from "../room";
import { Status, StatusMatrix } from "../status";

import { generateId, ProceduralViolation } from "../util";
import { CharacterEvents, ICharacterEvents } from "./events";
import type { ActionDetail, ActionHistoryEntry } from "./history";
import { MitigatorStatType, Stats, StatType } from "./stats";

/** Unique identifier for a {@link Character}. */
export type CharacterId = Brand<string, "CharacterId">;

// Damage mitigation: a mitigating stat of MAX_STAT fully absorbs the hit, while
// a mitigator of 0 doubles it. Each point of the mitigating stat removes
// MITIGATION_PER_POINT of the incoming damage multiplier.
const MAX_STAT = 10;
const MITIGATION_PER_POINT = 0.2;

/**
 * Any callable, used purely as an identity key in the action-tracking maps.
 * Preferred over the unsafe built-in `Function` type.
 */
export type ActionFn = (...args: never[]) => unknown;

/**
 * A participant in the game world and an {@link IItemHolder}.
 *
 * A character owns stats, status conditions, an inventory, and a per-turn action
 * budget. Actions are logged to its history and, when they count toward the
 * budget, advance the turn. {@link Character} is the base class; combat and
 * role-specific behaviour live in its subclasses.
 */
export interface ICharacter extends IItemHolder {
  // ### Properties
  readonly holderKind: "character";
  id: CharacterId;
  name: string;
  stats: Stats;
  /** Number of budgeted actions the character may take per turn. */
  actionsPerRound: number;
  /**
   * Marks which of the character's methods count as budgeted actions. Subclasses
   * register their own action methods here so {@link ICharacter.recordAction}
   * knows which ones tick the per-round counter.
   */
  readonly isActionMap: WeakMap<ActionFn, boolean>;

  /** The campaign this character belongs to. */
  get campaign(): ICampaign;
  /** The room the character currently occupies, or `null` if none. */
  get currentRoom(): IRoom | null;
  /** Immutable copy of the character's recorded action history. */
  get history(): readonly ActionHistoryEntry[];
  get inventory(): Inventory;
  /** Whether the character is free of all status conditions. */
  get isNormal(): boolean;
  /** The status conditions currently active on the character. */
  get status(): Status[];

  // ### Methods
  /** Picks up one or more items, recording a single `pickUp` action. */
  addToInventory: (item: IItem | IItem[]) => void;
  /** Ends the character's turn, firing end events and resolving statuses. */
  endTurn: () => void;
  /** Moves the character into `room`, leaving the current room first. */
  move: (room: IRoom) => void;
  /** Drops one or more items, recording a single `drop` action. */
  removeFromInventory: (item: IItem) => void;
  /** Logs an action to history and advances the turn if the budget is spent. */
  recordAction: (callingFn: ActionFn, detail: ActionDetail) => void;
  /** Begins the character's turn, resetting the action budget. */
  startTurn: () => void;
  /** Applies damage to a stat after mitigation, updating status conditions. */
  takeDamage: (attackStrength: number, attackStat?: StatType) => void;

  // ### Events
  /** Turn-lifecycle event hub for this character. */
  events: ICharacterEvents;
}

/**
 * Base implementation of {@link ICharacter}.
 *
 * Owns the character's stats, status matrix, inventory, and action history, and
 * implements the {@link IItemHolder} primitives. Damage is reduced by a
 * mitigating stat (a full mitigator absorbs the hit; an empty one doubles it),
 * and status conditions (KO, Panic, Fear, Confused) are recomputed from stats
 * whenever they change. Subclasses such as {@link Combatant} add further actions.
 */
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

  /** @returns Whether the inventory has a free slot. */
  hasRoomForItem() {
    return this.#inventory.items.length < this.#inventory.slots;
  }

  /**
   * Places `item` into the inventory and claims ownership of it. Low-level
   * holder primitive; {@link Character.addToInventory} is the action-recording
   * entry point.
   */
  receiveItem(item: IItem) {
    // Keys are stored "for free" in a separate compartment; everything else
    // takes a slot in `items`.
    if (item.type === "key") {
      this.#inventory.keys.push(item);
    } else {
      this.#inventory.items.push(item);
    }
    item[CLAIM](this);
  }

  /** Removes `item` from the inventory if present, leaving its holder untouched. */
  relinquishItem(item: IItem) {
    const fromItems = this.#inventory.items.findIndex(
      (current) => current.id === item.id,
    );
    if (fromItems !== -1) {
      this.#inventory.items.splice(fromItems, 1);
      return;
    }
    const fromKeys = this.#inventory.keys.findIndex(
      (current) => current.id === item.id,
    );
    if (fromKeys !== -1) {
      this.#inventory.keys.splice(fromKeys, 1);
    }
  }

  /**
   * @param campaign - The campaign the character belongs to.
   * @param name - Display name.
   * @param stats - Initial {@link Stats}.
   * @param inventorySlots - Inventory capacity. Defaults to 5.
   * @param actionsPerRound - Budgeted actions per turn. Defaults to 3.
   */
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

    this.#inventory = { slots: inventorySlots, items: [], keys: [] };
    this.#campaign = campaign;
    this.#status = new Map<Status, boolean>();
    this.#resetStatuses();

    this.isActionMap.set(this.addToInventory, true);
    this.isActionMap.set(this.removeFromInventory, true);
  }

  /**
   * Appends an entry to the action history, stamping it with the current
   * campaign round. If `callingFn` is registered in {@link Character.isActionMap}
   * it also consumes an action from the per-turn budget, automatically ending
   * the turn once the budget is exhausted.
   *
   * @param callingFn - The method recording the action, used as an identity key.
   * @param detail - The action payload, minus the `round` (stamped here).
   */
  recordAction(callingFn: ActionFn, detail: ActionDetail) {
    this.#history.push({
      ...detail,
      round: this.campaign.round,
    });

    if (this.isActionMap.get(callingFn)) {
      this.actionsThisRound = this.actionsThisRound + 1;
    }
    if (this.actionsThisRound === this.actionsPerRound) {
      this.endTurn();
    }
  }

  /**
   * Adds one or more items to the inventory, firing each item's `pickUp` action
   * and recording a single `pickUp` history entry for the batch.
   *
   * @param item - An item or array of items to pick up.
   * @throws {@link ProceduralViolation} if the inventory runs out of slots.
   */
  addToInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const current of items) {
      if (current.type === "key") {
        // Keys never consume a slot, so they bypass the room check entirely.
        this.receiveItem(current);
        current.actions.pickUp(this);
      } else if (this.hasRoomForItem()) {
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

  /**
   * Removes one or more items from the inventory, recording a single `drop`
   * history entry for the batch.
   *
   * @param item - An item or array of items to drop.
   * @throws {@link ProceduralViolation} if any item is a key (use transferKey instead).
   * @throws {@link ProceduralViolation} if any item is not in the inventory.
   */
  removeFromInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const current of items) {
      if (current.type === "key") {
        throw new ProceduralViolation(
          "Keys cannot be dropped; hand them over with transferKey instead.",
        );
      }
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

  /**
   * Applies an incoming attack to a stat after mitigation, then recomputes
   * status conditions and records a `takeDamage` action.
   *
   * The damage taken is `attackStrength * (MAX_STAT - mitigator) * 0.2`, where
   * the mitigator is the value of the stat that defends `attackStat` (see
   * {@link MitigatorStatType}). A full mitigator absorbs the hit entirely; an
   * empty one doubles it.
   *
   * @param attackStrength - Raw incoming attack strength before mitigation.
   * @param attackStat - The stat being attacked. Defaults to health.
   */
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

  /**
   * Moves the character into `room`, exiting the current room first (which fires
   * that room's exit scenes) and entering the new one (firing its enter scenes).
   * Records a `move` action.
   *
   * @param room - Destination room.
   */
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

  /** Ends the turn: fires end-of-turn events and resolves status conditions. */
  endTurn() {
    this.events.onTurnEnd();
    this.#resolveStatuses();
  }

  /**
   * Begins the turn: resets the per-round action budget, fires start-of-turn
   * events, and resolves status conditions.
   */
  startTurn() {
    this.actionsThisRound = 0;
    this.events.onTurnStart();
    this.#resolveStatuses();
  }
}
