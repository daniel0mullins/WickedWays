import type { Brand } from "../brand";
import { ICampaign } from "../campaign";
import { CLAIM, CONSUME_VIA_USE, DEPOSIT_MATERIALS, EQUIP, GRANT_IMMUNITY, IItem, IItemHolder, Inventory, MaterialMap, SET_DURABILITY, UNEQUIP } from "../inventory";
import {
  DEFAULT_EQUIPMENT_SLOTS,
  EquipmentSlot,
  SLOT_KIND,
} from "../equipment";
import { DEPLETE, type IMaterialCache } from "../material-cache";
import { IRoom } from "../room";
import { Status } from "../status";
import { Afflictions, AfflictionConfig, DEFAULT_AFFLICTION_CONFIG } from "./afflictions";

import { generateId, ProceduralViolation, typedEntries } from "../util";
import { CharacterEvents, ICharacterEvents } from "./events";
import type { ActionDetail, ActionHistoryEntry } from "./history";
import { MitigatorStatType, Stats, StatType } from "./stats";
import type { RecipeId } from "../crafting";

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
  /** Hands a key to another character (keyring to keyring; the only way keys change hands). */
  transferKey: (key: IItem, recipient: ICharacter) => void;
  /** Harvests a co-located material cache into the party pool (free; idempotent). */
  harvest: (cache: IMaterialCache) => void;
  /** Spends a key, removing it from the keyring. The sanctioned "story consumed this key" path. */
  consumeKey: (key: IItem) => void;
  /** Logs an action to history and advances the turn if the budget is spent. */
  recordAction: (callingFn: ActionFn, detail: ActionDetail) => void;
  /** Begins the character's turn, resetting the action budget. */
  startTurn: () => void;
  /** Applies damage to a stat after mitigation, updating status conditions. */
  takeDamage: (attackStrength: number, attackStat?: StatType) => void;
  /** Restores a damaged, durability-bearing held item to full for a proportional material cost (free). */
  repair: (item: IItem) => void;
  /** The character's currently filled equipment slots (named slot → item). */
  get equipment(): ReadonlyMap<EquipmentSlot, IItem>;
  /** Equips a held item into a named slot of its kind, auto-swapping conflicts (free). */
  equip: (item: IItem, targetSlot?: EquipmentSlot) => void;
  /** Removes an equipped item from its slot(s) (free). */
  unequip: (item: IItem) => void;
  /**
   * Crafts an item using the materials-track recipe identified by `recipeId`.
   * Returns `null` if the action was gated (fizzled due to Confused status).
   * Free action — does not tick the action budget or record history.
   */
  craft: (recipeId: RecipeId) => IItem | null;
  /**
   * The character's effective value for `stat`: the base stat plus the `modifier`
   * of every equipped accessory targeting it. Drives damage mitigation and status
   * thresholds; never mutates the base. Uncapped — the use site clamps.
   */
  effectiveStat: (stat: StatType) => number;

  /** Grants timed status immunity; engine-internal (item Use path only). */
  [GRANT_IMMUNITY]: (statuses: Status[], turns: number) => void;
  /** Consumes an item for the Use path, gating suppressed; engine-internal. */
  [CONSUME_VIA_USE]: (item: IItem) => void;

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
  // #slots is the character's anatomy (which named positions exist); #equipment
  // is current occupancy (named position → worn item). A two-handed weapon
  // appears under both hand keys.
  #equipment: Map<EquipmentSlot, IItem> = new Map();
  #slots: readonly EquipmentSlot[] = DEFAULT_EQUIPMENT_SLOTS;
  #afflictions: Afflictions;
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

  get equipment(): ReadonlyMap<EquipmentSlot, IItem> {
    return this.#equipment;
  }

  get isNormal() {
    return this.#afflictions.isNormal;
  }

  get status() {
    return this.#afflictions.list;
  }

  // Floors each base stat at 0 (mutates this.stats — intentional clamp), then
  // returns the effective snapshot (base + equipped-accessory bonuses).
  #floorAndSnapshot(): Stats {
    this.stats[StatType.Health] = Math.max(0, this.stats[StatType.Health]);
    this.stats[StatType.Sanity] = Math.max(0, this.stats[StatType.Sanity]);
    this.stats[StatType.Energy] = Math.max(0, this.stats[StatType.Energy]);
    return {
      [StatType.Health]: this.effectiveStat(StatType.Health),
      [StatType.Sanity]: this.effectiveStat(StatType.Sanity),
      [StatType.Energy]: this.effectiveStat(StatType.Energy),
    };
  }

  /** Statuses currently immunized by equipped, intact gear (passive immunity). */
  #passiveImmunities(): Set<Status> {
    const set = new Set<Status>();
    for (const item of this.#inventory.items) {
      if (!item.properties.equipped || item.isBroken || !item.immunities) continue;
      for (const s of item.immunities) set.add(s);
    }
    return set;
  }

  #reconcile() {
    this.#afflictions.applyFromStats(
      this.#floorAndSnapshot(),
      this.#passiveImmunities(),
    );
  }

  /** Grants timed status immunity. Engine-internal: only the item Use path calls it. */
  [GRANT_IMMUNITY](statuses: Status[], turns: number) {
    this.#afflictions.grantImmunity(statuses, turns);
  }

  // Set while a gated action is mid-flight so a nested same-character gated call
  // (escape -> move, loot -> add/remove, use -> remove) doesn't re-gate/re-roll.
  #suppressGate = false;

  /** Runs `fn` with affliction gating suppressed (same-character composition only). */
  protected withGateSuppressed<T>(fn: () => T): T {
    const prev = this.#suppressGate;
    this.#suppressGate = true;
    try {
      return fn();
    } finally {
      this.#suppressGate = prev;
    }
  }

  /**
   * Gates an attempted action against active afflictions. Throws on a hard block;
   * on a Confused fizzle records a fumble (which ticks the budget when `callingFn`
   * is a budgeted action) and returns false; otherwise returns true.
   */
  protected attemptAction(callingFn: ActionFn, isMove: boolean): boolean {
    if (this.#suppressGate) return true;
    const verdict = this.#afflictions.gate(isMove);
    if (verdict.kind === "block") {
      throw new ProceduralViolation(verdict.reason);
    }
    if (verdict.kind === "fizzle") {
      // `callingFn.name` labels the fumble; relies on un-minified method names
      // (true under tsc — revisit if a bundler is ever added).
      this.recordAction(callingFn, { kind: "fumble", action: callingFn.name });
      return false;
    }
    return true;
  }

  /**
   * Consumes an item on behalf of the item `Use` path: removes it with gating
   * suppressed (use is always allowed) while keeping the drop record + budget tick.
   */
  [CONSUME_VIA_USE](item: IItem) {
    this.withGateSuppressed(() => this.removeFromInventory(item));
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
   * @param options - Optional rng and affliction config for deterministic testing.
   */
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    this.id = generateId<CharacterId>();
    this.name = name;
    this.stats = stats;
    this.events = new CharacterEvents(this);
    this.actionsPerRound = actionsPerRound;
    this.actionsThisRound = 0;

    this.#inventory = { slots: inventorySlots, items: [], keys: [] };
    this.#campaign = campaign;
    this.#afflictions = new Afflictions(
      options.rng,
      options.afflictionConfig ?? DEFAULT_AFFLICTION_CONFIG,
    );

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
    if (!this.attemptAction(this.addToInventory, false)) return;
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
      // A picked-up item may impart a recipe to the whole party.
      if (current.teaches) {
        this.campaign.discoverRecipe(current.teaches);
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
    if (!this.attemptAction(this.removeFromInventory, false)) return;
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
   * Spends a key: removes it from the keyring and unhomes it ({@link CLAIM} null).
   * This is the only sanctioned removal path for a key — the player cannot drop
   * one (see {@link Character.removeFromInventory}). Scene scripts call this to
   * burn a one-shot key, typically guarded by the key's {@link IItem.consumeOnUse}.
   *
   * @param key - The key to consume.
   * @throws {@link ProceduralViolation} if this character is not holding `key`.
   */
  consumeKey(key: IItem) {
    const held = this.#inventory.keys.some((k) => k.id === key.id);
    if (!held) {
      throw new ProceduralViolation(
        "Attempted to consume a key the character is not holding.",
      );
    }
    this.relinquishItem(key);
    key[CLAIM](null);
  }

  /**
   * Restores a damaged, durability-bearing item to full durability, paying a
   * material cost proportional to the missing fraction (`ceil(recipe[c] * missing
   * / maxDurability)` per component) from the party pool. Free — it does not
   * consume a budgeted action or record history.
   *
   * @param item - A held item that has durability and is below full.
   * @throws {@link ProceduralViolation} if the item is not held, has no
   *   durability, is already at full, or the party cannot afford the cost.
   */
  repair(item: IItem) {
    if (!this.attemptAction(this.repair, false)) return;
    // Keys live on the keyring and carry no durability; reject them explicitly
    // rather than letting the held/durability guards report a confusing reason.
    if (item.type === "key") {
      throw new ProceduralViolation("Keys cannot be repaired.");
    }
    const held = this.#inventory.items.some((i) => i.id === item.id);
    if (!held) {
      throw new ProceduralViolation(
        "Cannot repair an item the character is not holding.",
      );
    }
    if (item.maxDurability === undefined || item.durability === undefined) {
      throw new ProceduralViolation("Cannot repair an item that has no durability.");
    }
    if (item.durability >= item.maxDurability) {
      throw new ProceduralViolation("Cannot repair an item that is not damaged.");
    }

    const missing = item.maxDurability - item.durability;
    const cost: MaterialMap = {};
    for (const [component, qty] of typedEntries(item.recipe) as Array<
      [keyof MaterialMap, number | undefined]
    >) {
      if (qty === undefined) continue;
      cost[component] = Math.ceil((qty * missing) / item.maxDurability);
    }

    if (!this.campaign.canAfford(cost)) {
      throw new ProceduralViolation("Not enough materials to repair.");
    }
    this.campaign.withdrawMaterials(cost);
    item[SET_DURABILITY](item.maxDurability);
  }

  /**
   * Equips a held item into one of the character's named slots of the item's
   * slot kind. Auto-assigns the first free slot of that kind (or the named
   * `targetSlot`), displacing whatever is there (the displaced item stays in
   * inventory, unequipped). A two-handed weapon spans both hand slots. Free — no
   * budgeted action, no history.
   *
   * @throws {@link ProceduralViolation} if the item is not held, not equippable,
   *   has no slot kind, the character has no slot of that kind, or `targetSlot`
   *   does not fit the item.
   */
  equip(item: IItem, targetSlot?: EquipmentSlot) {
    if (!this.attemptAction(this.equip, false)) return;
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot equip an item the character is not holding.");
    }
    if (!item.properties.equippable) {
      throw new ProceduralViolation("Item is not equippable.");
    }
    if (item.slot === undefined) {
      throw new ProceduralViolation("Item has no equipment slot.");
    }
    // Re-equipping a worn item: free its current slot(s) first.
    if (item.properties.equipped) {
      this.unequip(item);
    }

    // Two-handed weapons span both hands.
    if (item.type === "weapon" && item.twoHanded) {
      for (const hand of [EquipmentSlot.LeftHand, EquipmentSlot.RightHand]) {
        const occupant = this.#equipment.get(hand);
        if (occupant) this.unequip(occupant);
      }
      this.#equipment.set(EquipmentSlot.LeftHand, item);
      this.#equipment.set(EquipmentSlot.RightHand, item);
      item[EQUIP](this);
      return;
    }

    const eligible = this.#slots.filter((s) => SLOT_KIND[s] === item.slot);
    if (eligible.length === 0) {
      throw new ProceduralViolation("Character has no slot for this item.");
    }

    let slot: EquipmentSlot;
    if (targetSlot !== undefined) {
      if (!eligible.includes(targetSlot)) {
        throw new ProceduralViolation("Target slot does not fit this item.");
      }
      slot = targetSlot;
    } else {
      // First free eligible slot in canonical order, else displace the first.
      slot = eligible.find((s) => !this.#equipment.has(s)) ?? eligible[0]!;
    }

    const occupant = this.#equipment.get(slot);
    if (occupant && occupant.id !== item.id) {
      this.unequip(occupant); // auto-swap (a 2H occupant frees both hands)
    }
    this.#equipment.set(slot, item);
    item[EQUIP](this);
  }

  /**
   * Removes an equipped item from every slot it occupies (a two-handed weapon
   * occupies two). Free — no budgeted action, no history.
   *
   * @throws {@link ProceduralViolation} if the item is not held or not equipped.
   */
  unequip(item: IItem) {
    if (!this.attemptAction(this.unequip, false)) return;
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot unequip an item the character is not holding.");
    }
    if (!item.properties.equipped) {
      throw new ProceduralViolation("Item is not equipped.");
    }
    for (const slot of [...this.#equipment.keys()]) {
      if (this.#equipment.get(slot)?.id === item.id) {
        this.#equipment.delete(slot);
      }
    }
    item[UNEQUIP](this);
  }

  /**
   * Hands a key to another character. Keys are never dropped or stowed, so this
   * keyring-to-keyring move is the only way a key changes hands. The recipient
   * records it as a single `pickUp` (which counts as one of the recipient's
   * actions for the turn); the giver's side is silent (it is not a drop).
   *
   * @param key - A key currently in this character's keyring.
   * @param recipient - The character receiving the key.
   * @throws {@link ProceduralViolation} if this character is not holding `key`.
   */
  transferKey(key: IItem, recipient: ICharacter) {
    if (!this.attemptAction(this.transferKey, false)) return;
    const held = this.#inventory.keys.some((k) => k.id === key.id);
    if (!held) {
      throw new ProceduralViolation(
        "Attempted to transfer a key the character is not holding.",
      );
    }
    // Add to the recipient FIRST, then relinquish: if the recipient's gated
    // addToInventory blocks (e.g. KO'd ally), the key is not lost from the giver.
    recipient.addToInventory(key);
    this.relinquishItem(key);
  }

  /**
   * Harvests a material cache in the character's current room into the party
   * pool. Idempotent: harvesting an already-depleted cache deposits nothing. Free
   * — it does not consume a budgeted action.
   *
   * @param cache - A cache present in the character's current room.
   * @throws {@link ProceduralViolation} if the cache is not in the current room.
   */
  harvest(cache: IMaterialCache) {
    if (!this.#currentRoom?.materials.has(cache.id)) {
      throw new ProceduralViolation(
        "Cannot harvest a material cache that is not in the current room",
      );
    }
    this.campaign[DEPOSIT_MATERIALS](cache[DEPLETE]());
  }

  effectiveStat(stat: StatType): number {
    const bonus = this.#inventory.items
      .filter(
        (item) =>
          item.properties.equipped &&
          item.type === "accessory" &&
          item.stat === stat,
      )
      .reduce((sum, item) => sum + item.modifier, 0);
    return this.stats[stat] + bonus;
  }

  /**
   * Applies an incoming attack to a stat after mitigation, then recomputes
   * status conditions and records a `takeDamage` action.
   *
   * Equipped, non-broken armor whose `stat` matches `attackStat` first subtracts
   * its `modifier` from the raw strength (floored at 0); the remainder is then
   * `* max(0, MAX_STAT - mitigator) * 0.2`, where the mitigator is the *effective*
   * value (base plus equipped-accessory bonuses, see {@link effectiveStat}) of the
   * stat that defends `attackStat` (see {@link MitigatorStatType}). The `max(0, …)`
   * means an over-cap mitigator fully absorbs the hit rather than healing.
   * Contributing armor wears one point.
   *
   * @param attackStrength - Raw incoming attack strength before mitigation.
   * @param attackStat - The stat being attacked. Defaults to health.
   */
  takeDamage(attackStrength: number, attackStat: StatType = StatType.Health) {
    // Equipped, intact armor defending this stat soaks raw strength first — the
    // defensive counterpart to how attacking weapons add to raw attack strength.
    const armor = this.#inventory.items.filter(
      (item) =>
        item.properties.equipped &&
        item.type === "armor" &&
        !item.isBroken &&
        item.stat === attackStat,
    );
    const armorSum = armor.reduce((sum, piece) => sum + piece.modifier, 0);
    const mitigatedStrength = Math.max(0, attackStrength - armorSum);

    const mitigator = this.effectiveStat(MitigatorStatType[attackStat]);
    const damageMultiplier = Math.max(0, MAX_STAT - mitigator) * MITIGATION_PER_POINT;
    const finalAttackStrength = mitigatedStrength * damageMultiplier;

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;

    // Each contributing armor piece wears for the blow it helped absorb.
    armor.forEach((piece) => {
      if (piece.maxDurability !== undefined) {
        // durability is defined whenever maxDurability is (see Item constructor).
        piece[SET_DURABILITY](piece.durability! - 1);
      }
    });

    this.#reconcile();
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
    if (!this.attemptAction(this.move, true)) return;
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

  /** Ends the turn: fires end-of-turn events and reconciles status conditions. */
  endTurn() {
    this.events.onTurnEnd();
    this.#reconcile();
  }

  /**
   * Begins the turn: resets the per-round action budget, fires start-of-turn
   * events, and ticks timed immunities then reconciles status conditions.
   */
  startTurn() {
    this.actionsThisRound = 0;
    this.events.onTurnStart();
    this.#afflictions.onTurnStart(
      this.#floorAndSnapshot(),
      this.#passiveImmunities(),
    );
  }

  /**
   * Crafts the item produced by the recipe identified by `recipeId`. Supports
   * both the materials track (debits the party pool, places the output in an
   * inventory slot) and the key track (consumes held keys, places the output on
   * the keyring). Free action — does not tick the action budget or record history.
   *
   * @param recipeId - The id of a known recipe.
   * @returns The newly created item, or `null` if the action was gated (fizzled).
   * @throws {@link ProceduralViolation} if the recipe is unknown.
   * @throws {@link ProceduralViolation} if the party pool cannot cover the cost (materials track).
   * @throws {@link ProceduralViolation} if there is no free inventory slot (materials track).
   * @throws {@link ProceduralViolation} if a key-track recipe's required keys are not all held.
   */
  craft(recipeId: RecipeId): IItem | null {
    if (!this.attemptAction(this.craft, false)) return null;
    const recipe = this.campaign.knownRecipes.get(recipeId);
    if (!recipe) {
      throw new ProceduralViolation("Cannot craft an undiscovered recipe");
    }
    if ("materials" in recipe) {
      if (!this.campaign.canAfford(recipe.materials)) {
        throw new ProceduralViolation("Not enough materials to craft");
      }
      if (!this.hasRoomForItem()) {
        throw new ProceduralViolation("No inventory slot for the crafted item");
      }
      this.campaign.withdrawMaterials(recipe.materials);
      const output = recipe.create();
      this.receiveItem(output);
      return output;
    }
    // Key track. Total demand per code first, so a recipe that lists the same
    // code twice is treated as a single combined cost rather than checked
    // against the full keyring twice.
    const demand = new Map<string, number>();
    for (const { keyCode, qty } of recipe.keys) {
      demand.set(keyCode, (demand.get(keyCode) ?? 0) + qty);
    }
    // Verify EVERY code is satisfiable BEFORE consuming anything, so a recipe
    // the character can't fully supply consumes nothing.
    for (const [keyCode, qty] of demand) {
      const held = this.#inventory.keys.filter((k) => k.keyCode === keyCode);
      if (held.length < qty) {
        throw new ProceduralViolation("Missing required keys to craft");
      }
    }
    for (const [keyCode, qty] of demand) {
      const held = this.#inventory.keys.filter((k) => k.keyCode === keyCode);
      for (const key of held.slice(0, qty)) {
        this.consumeKey(key);
      }
    }
    const output = recipe.create();
    this.receiveItem(output);
    return output;
  }
}
