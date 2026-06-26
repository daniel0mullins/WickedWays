import type { Brand } from "../brand";
import { ICampaign } from "../campaign";
import { ADD_LIGHT_SOURCE, CLAIM, CONSUME_VIA_USE, DEPOSIT_MATERIALS, EQUIP, GRANT_IMMUNITY, IItem, IItemHolder, Inventory, ItemAction, MaterialMap, PLACE, REMOVE_LIGHT_SOURCE, SET_DURABILITY, UNEQUIP } from "../inventory";
import {
  DEFAULT_EQUIPMENT_SLOTS,
  EquipmentSlot,
  SLOT_KIND,
} from "../equipment";
import { DEPLETE, type IMaterialCache } from "../material-cache";
import { IRoom, type Direction } from "../room";
import { Status } from "../status";
import { Afflictions, AfflictionConfig, DEFAULT_AFFLICTION_CONFIG } from "./afflictions";
import { EMIT_CUE } from "../presentation";
import type { AssetRef, Presentation } from "../presentation";
import { RECORD_ENCOUNTER } from "../codex";

import { generateId, ProceduralViolation, typedEntries } from "../util";
import { CharacterEvents, ICharacterEvents } from "./events";
import type { ActionDetail, ActionHistoryEntry } from "./history";
import { MitigatorStatType, Stats, StatType } from "./stats";
import type { RecipeId } from "../crafting";
import { SERIALIZE, HYDRATE } from "../serialization/symbols";
import type { CharacterSnapshot } from "../serialization/types";
import type { HydrateContext } from "../serialization/context";
import { ADJUST_STAT, DISPATCH_TURN, DISPATCH_ACTION, TRANSFORM_DAMAGE, INVOKE_MECHANIC_ACTION } from "../mechanics/symbols";
import type { IPlayerCharacter } from "./player-character";

/** Unique identifier for a {@link Character}. */
export type CharacterId = Brand<string, "CharacterId">;

// Damage mitigation: a mitigating stat of MAX_STAT fully absorbs the hit, while
// a mitigator of 0 doubles it. Each point of the mitigating stat removes
// MITIGATION_PER_POINT of the incoming damage multiplier.
const MAX_STAT = 10;
const MITIGATION_PER_POINT = 0.2;

/** Damage multiplier applied to a light-averse creature while its room is lit. */
export const LIGHT_VULNERABILITY = 1.5;

/**
 * Any callable, used purely as an identity key in the action-tracking maps.
 * Preferred over the unsafe built-in `Function` type.
 */
export type ActionFn = (...args: never[]) => unknown;

/** Constructor options shared by every character. */
export interface CharacterOptions {
  /** The campaign the character belongs to. */
  campaign: ICampaign;
  /** Display name. */
  name: string;
  /** Initial {@link Stats}. */
  stats: Stats;
  /** Inventory capacity. Defaults to 5. */
  inventorySlots?: number;
  /** Budgeted actions per turn. Defaults to 3. */
  actionsPerRound?: number;
  /** Injected randomness for deterministic tests. */
  rng?: () => number;
  /** Overrides the default affliction thresholds/roll config. */
  afflictionConfig?: AfflictionConfig;
  /** Optional presentation metadata (image/sound) for the Play Surface. */
  presentation?: Presentation;
}

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
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
  /** The room the character currently occupies, or `null` if none. */
  get currentRoom(): IRoom | null;
  /** True when the character has an equipped, non-broken light source in a hand slot. */
  get hasLight(): boolean;
  /** Whether this actor can act (attack/loot/harvest) in an unlit room. */
  get seesInDark(): boolean;
  /** Wires this character into `room` (current room + occupancy) with no gating, history, or budget tick. */
  [PLACE]: (room: IRoom) => void;
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
  /**
   * Evaluates the {@link Exit} in `direction` from the current room,
   * emits pass/fail narration, and moves on success. Budgeted (like `move`).
   */
  go: (direction: Direction) => void;
  /** Drops one or more items, recording a single `drop` action. */
  removeFromInventory: (item: IItem | IItem[]) => void;
  /** Hands a key to another character (keyring to keyring; the only way keys change hands). */
  transferKey: (key: IItem, recipient: ICharacter) => void;
  /** Harvests a co-located material cache into the party pool (free; idempotent). */
  harvest: (cache: IMaterialCache) => void;
  /** Moves a held emitsLight item into the current room's light sources (free). */
  placeLight: (item: IItem) => void;
  /** Moves a placed light source from the current room back into inventory (free). */
  takeLight: (item: IItem) => void;
  /** Spends a key, removing it from the keyring. The sanctioned "story consumed this key" path. */
  consumeKey: (key: IItem) => void;
  /** Logs an action to history and advances the turn if the budget is spent. */
  recordAction: (callingFn: ActionFn, detail: ActionDetail) => void;
  /** Begins the character's turn, resetting the action budget. */
  startTurn: () => void;
  /** Applies damage to a stat after mitigation, updating status conditions. */
  takeDamage: (attackStrength: number, attackStat?: StatType) => void;
  /**
   * Invokes a named custom action on an enabled mechanic (budgeted, status-gated).
   * Routes through `Campaign[INVOKE_MECHANIC_ACTION]`. v1 treats every custom action
   * as cost 1 via the standard budget path; the `cost` field on {@link CustomAction}
   * is accepted by the type and reserved for a future enhancement.
   *
   * @param mechanicKey - Registry key of the target mechanic.
   * @param actionKey   - The action to invoke on that mechanic (must be in its `actions` map).
   */
  useMechanicAction: (mechanicKey: string, actionKey: string) => void;
  /** Restores a damaged, durability-bearing held item to full for a proportional material cost (free). */
  repair: (item: IItem) => void;
  /** The character's currently filled equipment slots (named slot → item). */
  get equipment(): ReadonlyMap<EquipmentSlot, IItem>;
  /**
   * Equips a held item into a named slot of its kind, auto-swapping conflicts (free).
   * A Confused fizzle records a `fumble` to history but still does not tick the action budget.
   */
  equip: (item: IItem, targetSlot?: EquipmentSlot) => void;
  /**
   * Removes an equipped item from its slot(s) (free).
   * A Confused fizzle records a `fumble` to history but still does not tick the action budget.
   */
  unequip: (item: IItem) => void;
  /**
   * Reads a held item, surfacing its {@link IItem.lore} as a cue and firing its
   * `onRead` hook. Free, ungated, and non-consuming — the item stays in inventory
   * and may be read again. No-op cue when the item has no lore.
   * @throws {@link ProceduralViolation} if the item is not held.
   */
  read: (item: IItem) => void;
  /**
   * Crafts an item using the materials-track recipe identified by `recipeId`.
   * Returns `null` if the action was gated (fizzled due to Confused status).
   * Free action — does not tick the action budget or record history.
   * A Confused fizzle records a `fumble` to history but still does not tick the action budget.
   */
  craft: (recipeId: RecipeId) => IItem | null;
  /**
   * The character's effective value for `stat`: the base stat plus the `modifier`
   * of every equipped accessory targeting it. Drives damage mitigation and status
   * thresholds; never mutates the base. Uncapped — the use site clamps.
   */
  effectiveStat: (stat: StatType) => number;

  /**
   * Mechanics seam: apply a raw, unmitigated delta to a base stat, floored at 0.
   * The ONLY mechanic-facing stat mutator; magnitudes are pre-clamped by the applier.
   * Unforgeable (symbol-keyed).
   */
  [ADJUST_STAT]: (stat: StatType, delta: number) => void;
  /** Grants timed status immunity; engine-internal (item Use path only). */
  [GRANT_IMMUNITY]: (statuses: Status[], turns: number) => void;
  /** Consumes an item for the Use path, gating suppressed; engine-internal. */
  [CONSUME_VIA_USE]: (item: IItem) => void;

  // ### Events
  /** Turn-lifecycle event hub for this character. */
  events: ICharacterEvents;

  /** Returns a plain-data snapshot of this character's state. See {@link SERIALIZE}. */
  [SERIALIZE](): CharacterSnapshot;
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
  /** Injected randomness for all of this character's rolls (escape, etc.). */
  protected readonly rng: () => number;
  #history: ActionHistoryEntry[] = [];
  #inventory: Inventory;
  // #slots is the character's anatomy (which named positions exist); #equipment
  // is current occupancy (named position → worn item). A two-handed weapon
  // appears under both hand keys.
  #equipment: Map<EquipmentSlot, IItem> = new Map();
  #slots: readonly EquipmentSlot[] = DEFAULT_EQUIPMENT_SLOTS;
  /**
   * Standing status immunities granted by a selected archetype. Set only by
   * PlayerCharacter.selectArchetype; read by #passiveImmunities. Protected (not
   * public) so untrusted code can't forge it — same hidden-state discipline as
   * the rest of the character.
   */
  protected archetypeImmunities: Status[] = [];
  #afflictions: Afflictions;
  #presentation?: Presentation;
  protected actionsThisRound: number;

  // Public Getters
  get campaign() {
    return this.#campaign;
  }

  get currentRoom() {
    return this.#currentRoom;
  }

  /** Whether this actor can act (attack/loot/harvest) in an unlit room. Default false; light-averse mobs override. */
  get seesInDark(): boolean {
    return false;
  }

  /** Whether this actor takes amplified damage while its room is lit. Default false; light-averse subclasses override. */
  protected get lightAverse(): boolean {
    return false;
  }

  /**
   * Throws if the actor is in an unlit room and cannot see in the dark. Targeting
   * actions (attack/loot/harvest) call this; movement and light actions do not.
   *
   * @param verb - The blocked action, for the error message.
   */
  protected requireVisibleTarget(verb: string) {
    const room = this.#currentRoom;
    if (room && !room.isLit && !this.seesInDark) {
      throw new ProceduralViolation(`Cannot ${verb} in the dark`);
    }
  }

  /** True when the character has an equipped, non-broken light source in a hand slot. */
  get hasLight(): boolean {
    for (const slot of [EquipmentSlot.LeftHand, EquipmentSlot.RightHand]) {
      const item = this.equipment.get(slot);
      if (item?.emitsLight && !item.isBroken) return true;
    }
    return false;
  }

  get history(): readonly ActionHistoryEntry[] {
    return [...this.#history];
  }

  get inventory() {
    return this.#inventory;
  }

  get presentation(): Presentation | undefined {
    return this.#presentation;
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

  /** Statuses currently immunized by equipped, intact gear or the selected archetype. */
  #passiveImmunities(): Set<Status> {
    const set = new Set<Status>();
    for (const item of this.#inventory.items) {
      if (!item.properties.equipped || item.isBroken || !item.immunities) continue;
      for (const s of item.immunities) set.add(s);
    }
    for (const s of this.archetypeImmunities) set.add(s);
    return set;
  }

  #reconcile() {
    const wasKO = this.#afflictions.list.includes(Status.KO);
    this.#afflictions.applyFromStats(
      this.#floorAndSnapshot(),
      this.#passiveImmunities(),
    );
    const isKO = this.#afflictions.list.includes(Status.KO);
    if (!wasKO && isKO) {
      this.onKnockOut();
    }
  }

  /**
   * Hook fired exactly once when this character's {@link Status.KO} newly
   * latches during a reconcile. Base behaviour is none; subclasses (e.g.
   * {@link Mob}) override it to react to defeat.
   */
  protected onKnockOut(): void {}

  /** Grants timed status immunity. Engine-internal: only the item Use path calls it. */
  [GRANT_IMMUNITY](statuses: Status[], turns: number) {
    this.#afflictions.grantImmunity(statuses, turns);
  }

  /**
   * Mechanics seam: apply a raw, unmitigated delta to a base stat, floored at 0,
   * then reconcile afflictions. The ONLY mechanic-facing stat mutator; magnitudes
   * are pre-clamped by the applier. Unforgeable (symbol-keyed).
   */
  [ADJUST_STAT](stat: StatType, delta: number): void {
    this.stats[stat] = Math.max(0, this.stats[stat] + delta);
    this.#reconcile();
  }

  // Set while a gated action is mid-flight so a nested same-character gated call
  // (escape -> move, loot -> add/remove, use -> remove) doesn't re-gate/re-roll.
  #suppressGate = false;

  // Set transiently so an action recorded inside a wrapped call (e.g. a loot-box
  // exchange) attributes its cue sound to the involved container rather than the
  // actor. Mirrors #suppressGate.
  #cueSoundOverride: AssetRef | undefined;

  // Set while a composite light action (placeLight) performs an internal unequip,
  // so the nested unequip's transient lit:false flicker is not emitted — only the
  // composite's net flip is. Mirrors #suppressGate.
  #suppressVisibility = false;

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
   * Runs `fn` with visibility-cue emission suppressed, so a composite light
   * action (e.g. an `equip` auto-swap, or `placeLight`'s internal unequip) does
   * not emit the transient lit-state flickers of its inner steps. The composite
   * emits its own net flip once, after `fn` completes.
   */
  #withVisibilitySuppressed<T>(fn: () => T): T {
    const prev = this.#suppressVisibility;
    this.#suppressVisibility = true;
    try {
      return fn();
    } finally {
      this.#suppressVisibility = prev;
    }
  }

  /** Runs `fn` with `sound` as the cue-sound override for any action it records. */
  protected withCueSound<T>(sound: AssetRef | undefined, fn: () => T): T {
    const prev = this.#cueSoundOverride;
    this.#cueSoundOverride = sound;
    try {
      return fn();
    } finally {
      this.#cueSoundOverride = prev;
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

  /** See {@link CharacterOptions} for parameter details. */
  constructor(opts: CharacterOptions) {
    const { inventorySlots = 5, actionsPerRound = 3 } = opts;
    this.id = generateId<CharacterId>();
    this.name = opts.name;
    this.stats = opts.stats;
    this.events = new CharacterEvents(this);
    this.actionsPerRound = actionsPerRound;
    this.actionsThisRound = 0;

    this.#inventory = { slots: inventorySlots, items: [], keys: [] };
    this.#campaign = opts.campaign;
    this.rng = opts.rng ?? Math.random;
    this.#afflictions = new Afflictions(
      this.rng,
      opts.afflictionConfig ?? DEFAULT_AFFLICTION_CONFIG,
    );
    this.#presentation = opts.presentation;

    this.isActionMap.set(this.addToInventory, true);
    this.isActionMap.set(this.removeFromInventory, true);
    this.isActionMap.set(this.useMechanicAction, true);
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

    // Entity sound: the loot-box override when set, else the actor's own sound.
    // The campaign fills the action-kind default when this is undefined.
    this.campaign[EMIT_CUE]({
      kind: "action",
      action: detail.kind,
      actor: { id: this.id, name: this.name },
      sound: this.#cueSoundOverride ?? this.#presentation?.sound,
    });

    const budgeted = this.isActionMap.get(callingFn) === true;
    if (budgeted) {
      this.actionsThisRound = this.actionsThisRound + 1;
      this.campaign[DISPATCH_ACTION](detail, this as unknown as IPlayerCharacter);
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
        this.campaign.discoverRecipe(current.teaches, this);
      }
      this.campaign[RECORD_ENCOUNTER]({ kind: "item", item: current }, this, this.currentRoom);
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
   * consume a budgeted action or record history. A Confused fizzle records a
   * `fumble` to history but still does not tick the action budget.
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
   * budgeted action, no history. A Confused fizzle records a `fumble` to history
   * but still does not tick the action budget.
   *
   * @throws {@link ProceduralViolation} if the item is not held, not equippable,
   *   has no slot kind, the character has no slot of that kind, or `targetSlot`
   *   does not fit the item.
   */
  equip(item: IItem, targetSlot?: EquipmentSlot) {
    if (!this.attemptAction(this.equip, false)) return;
    const flipRoom = this.#currentRoom;
    const flipWasLit = flipRoom?.isLit ?? true;
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot equip an item the character is not holding.");
    }
    if (!item.properties.equippable) {
      throw new ProceduralViolation("Item is not equippable.");
    }
    if (item.slot === undefined) {
      throw new ProceduralViolation("Item has no equipment slot.");
    }
    // Re-equipping a worn item: free its current slot(s) first. Suppress this
    // preliminary unequip's visibility flicker — the re-equip as a whole is one
    // net transition, emitted once at the end against flipWasLit.
    if (item.properties.equipped) {
      this.#withVisibilitySuppressed(() => this.withGateSuppressed(() => this.unequip(item)));
    }

    // Two-handed weapons span both hands.
    if (item.type === "weapon" && item.twoHanded) {
      // Suppress the inner unequips' transient flickers; emit the net flip once.
      this.#withVisibilitySuppressed(() => {
        for (const hand of [EquipmentSlot.LeftHand, EquipmentSlot.RightHand]) {
          const occupant = this.#equipment.get(hand);
          if (occupant) this.withGateSuppressed(() => this.unequip(occupant));
        }
        this.#equipment.set(EquipmentSlot.LeftHand, item);
        this.#equipment.set(EquipmentSlot.RightHand, item);
        item[EQUIP](this);
      });
      this.#emitVisibilityIfFlipped(flipRoom ?? undefined, flipWasLit);
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

    // Suppress the auto-swap unequip's transient flicker; emit the net flip once.
    this.#withVisibilitySuppressed(() => {
      const occupant = this.#equipment.get(slot);
      if (occupant && occupant.id !== item.id) {
        this.withGateSuppressed(() => this.unequip(occupant)); // auto-swap (a 2H occupant frees both hands)
      }
      this.#equipment.set(slot, item);
      item[EQUIP](this);
    });
    this.#emitVisibilityIfFlipped(flipRoom ?? undefined, flipWasLit);
  }

  /**
   * Removes an equipped item from every slot it occupies (a two-handed weapon
   * occupies two). Free — no budgeted action, no history. A Confused fizzle
   * records a `fumble` to history but still does not tick the action budget.
   *
   * @throws {@link ProceduralViolation} if the item is not held or not equipped.
   */
  unequip(item: IItem) {
    if (!this.attemptAction(this.unequip, false)) return;
    const flipRoom = this.#currentRoom;
    const flipWasLit = flipRoom?.isLit ?? true;
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
    this.#emitVisibilityIfFlipped(flipRoom ?? undefined, flipWasLit);
  }

  /**
   * Reads a held item: runs its `read` behaviour/`onRead` hook and emits its
   * {@link IItem.lore} as a `mechanic` cue. Free, ungated, and non-consuming — no
   * budget tick, no history, and the item remains in inventory (re-readable). A
   * lore-less item is a quiet no-op.
   *
   * @throws {@link ProceduralViolation} if the item is not held.
   */
  read(item: IItem) {
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot read an item the character is not holding.");
    }
    item.actions[ItemAction.Read]?.(this);
    if (item.lore !== undefined) {
      this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: item.lore } });
    }
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
    // Only release the key if the recipient actually received it. A KO'd recipient
    // throws before we get here; a Confused recipient can silently fizzle the
    // pickup, in which case the key must stay with the giver rather than vanish.
    if (recipient.inventory.keys.some((k) => k.id === key.id)) {
      this.relinquishItem(key);
    }
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
    this.requireVisibleTarget("harvest");
    if (!this.#currentRoom?.materials.has(cache.id)) {
      throw new ProceduralViolation(
        "Cannot harvest a material cache that is not in the current room",
      );
    }
    const mats = cache[DEPLETE]();
    this.campaign[DEPOSIT_MATERIALS](mats);
    for (const [component, qty] of typedEntries(mats) as Array<
      [keyof MaterialMap, number | undefined]
    >) {
      if (qty === undefined) continue;
      this.campaign[RECORD_ENCOUNTER](
        { kind: "material", material: component },
        this,
        this.#currentRoom,
      );
    }
  }

  /**
   * Moves an emitsLight item the character holds into the current room's light
   * sources, where it stays lit regardless of occupancy. If the light was equipped
   * in a hand it is unequipped first (clearing its slot). Free action (no budget tick).
   *
   * @throws {@link ProceduralViolation} if the character is not in a room, the item
   *   is not an emitsLight item, or the character does not hold it.
   */
  placeLight(item: IItem) {
    const room = this.#currentRoom;
    if (!room) {
      throw new ProceduralViolation("Cannot place a light while not in a room");
    }
    // Capture before any state change (the unequip-on-place step below can move
    // the room's lit state) so the flip is detected against the original state.
    const wasLit = room.isLit;
    if (!item.emitsLight) {
      throw new ProceduralViolation("Cannot place a non-light item as a light source");
    }
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot place a light the character does not hold");
    }
    // A carried light may be equipped in a hand; clear its slot first so the
    // placed item isn't left with a phantom #equipment reference / equipped flag.
    // Suppress the nested unequip's visibility flicker — the place as a whole is
    // the meaningful transition, emitted once at the end against `wasLit`.
    if (item.properties.equipped) {
      this.#withVisibilitySuppressed(() => this.withGateSuppressed(() => this.unequip(item)));
    }
    this.relinquishItem(item);
    room[ADD_LIGHT_SOURCE](item);
    item[CLAIM](null);
    this.#emitVisibilityIfFlipped(room, wasLit);
  }

  /**
   * Moves a placed light source from the current room back into the character's
   * inventory. Free action (no budget tick).
   *
   * @throws {@link ProceduralViolation} if the item is not in the room's light sources.
   */
  takeLight(item: IItem) {
    const room = this.#currentRoom;
    if (!room || !room.lightSources.has(item.id)) {
      throw new ProceduralViolation("Cannot take a light that is not in the room");
    }
    const wasLit = room.isLit;
    room[REMOVE_LIGHT_SOURCE](item.id);
    this.receiveItem(item);
    this.#emitVisibilityIfFlipped(room, wasLit);
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
    const lightMultiplier =
      this.lightAverse && this.#currentRoom?.isLit ? LIGHT_VULNERABILITY : 1;
    const finalAttackStrength = mitigatedStrength * damageMultiplier * lightMultiplier;

    const dealt = this.campaign[TRANSFORM_DAMAGE]({
      amount: finalAttackStrength,
      target: this.id,
      stat: attackStat,
      source: undefined,
    });
    this.stats[attackStat] = this.stats[attackStat] - dealt;

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
      amount: dealt,
      stat: attackStat,
    });
  }

  /**
   * Engine-internal placement: sets the current room and occupancy directly,
   * exiting any prior room first. Unlike {@link Character.move} it is ungated,
   * records no history, and ticks no action budget. Used to seat resident or
   * spawned mobs (see {@link Room.placeMob} and the encounter spawn path).
   */
  [PLACE](room: IRoom) {
    // Mob seating / test co-location: intentionally no party-facing visibility cue.
    this.#enterRoom(room);
  }

  /**
   * Shared room-entry body for {@link Character.move} and the {@link PLACE} seam:
   * exits any current room and enters `room`, firing exit/enter scenes. Does NOT
   * emit a visibility cue — the enter-cue is party-facing and belongs to the
   * gameplay navigation path only ({@link Character.move}), not the ungated
   * placement seam ({@link PLACE}) used to seat resident/spawned mobs.
   */
  #enterRoom(room: IRoom) {
    if (this.#currentRoom) {
      this.#currentRoom.exitRoom(this);
    }
    this.#currentRoom = room;
    room.enterRoom(this);
  }

  /** Emits a visibility cue if a dark room's lit state changed across a light action. */
  #emitVisibilityIfFlipped(room: IRoom | undefined, wasLit: boolean) {
    if (this.#suppressVisibility) return;
    if (room && room.dark && room.isLit !== wasLit) {
      this.campaign[EMIT_CUE]({
        kind: "visibility",
        room: { id: room.id, name: room.name },
        lit: room.isLit,
      });
    }
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
    this.#enterRoom(room);
    if (!room.isLit) {
      this.campaign[EMIT_CUE]({
        kind: "visibility",
        room: { id: room.id, name: room.name },
        lit: false,
      });
    }
    this.recordAction(this.move, {
      kind: "move",
      room: { id: room.id, name: room.name },
    });
  }

  /**
   * Evaluates the {@link Exit} in `direction` from the current room:
   * - No exit → emits a soft "can't go that way" mechanic cue and returns.
   * - Precondition fails → emits `failMessage` (if any) as a mechanic cue and returns.
   * - Precondition passes → runs the exit script (or falls back to `passMessage`),
   *   emits the resulting line as a mechanic cue, then moves to the far room.
   *
   * Budgeted action (like `move`). Uses {@link withGateSuppressed} for the inner
   * `move` call to avoid double-gating (affliction check runs once, here).
   *
   * @param direction - The compass direction to travel.
   * @throws {@link ProceduralViolation} if the character is not in any room.
   */
  go(direction: Direction) {
    if (!this.attemptAction(this.go, true)) return;
    const here = this.currentRoom;
    if (here == null) throw new ProceduralViolation("Cannot move: not in any room.");
    const exit = here.exits.get(direction);
    if (exit === undefined) {
      this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: "You can't go that way." } });
      return;
    }
    if (!exit.canPass(this)) {
      if (exit.failMessage) this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: exit.failMessage } });
      return;
    }
    const line = exit.runScript(this) ?? exit.passMessage;
    if (line) this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: line } });
    this.withGateSuppressed(() => this.move(exit.otherSide(here)));
  }

  /** Ends the turn: fires end-of-turn events and reconciles status conditions. */
  endTurn() {
    this.events.onTurnEnd();
    this.#reconcile();
    this.campaign[DISPATCH_TURN]("end", this as unknown as IPlayerCharacter);
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
    this.campaign[DISPATCH_TURN]("start", this as unknown as IPlayerCharacter);
  }

  /**
   * Invokes a named custom action on an enabled mechanic (budgeted, status-gated).
   * v1 treats every custom action as cost 1 via the standard budget path; the
   * `cost` field on `CustomAction` is accepted by the type and reserved for a
   * future enhancement.
   *
   * @param mechanicKey - Registry key of the target mechanic.
   * @param actionKey - The action to invoke on that mechanic.
   */
  useMechanicAction(mechanicKey: string, actionKey: string): void {
    if (!this.attemptAction(this.useMechanicAction, false)) return;
    this.campaign[INVOKE_MECHANIC_ACTION](mechanicKey, actionKey, this as unknown as IPlayerCharacter);
    this.recordAction(this.useMechanicAction, { kind: "mechanicAction", mechanic: mechanicKey, action: actionKey });
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Returns a plain-data snapshot of this character suitable for persistence.
   * Subclasses contribute their own fields via {@link serializeKind} and
   * {@link serializeExtra}.
   */
  [SERIALIZE](): CharacterSnapshot {
    const base = {
      kind: this.serializeKind(),
      id: this.id,
      name: this.name,
      stats: { ...this.stats },
      actionsPerRound: this.actionsPerRound,
      actionsThisRound: this.actionsThisRound,
      currentRoomId: this.#currentRoom?.id ?? null,
      inventory: {
        slots: this.#inventory.slots,
        itemIds: this.#inventory.items.map((i) => i.id),
        keyIds: this.#inventory.keys.map((k) => k.id),
      },
      equipment: Object.fromEntries([...this.#equipment].map(([slot, item]) => [slot, item.id])),
      history: [...this.#history],
      archetypeImmunities: [...this.archetypeImmunities],
      afflictions: this.#afflictions[SERIALIZE](),
    } as CharacterSnapshot;
    this.serializeExtra(base);
    return base;
  }

  /** Subclass discriminant. */
  protected serializeKind(): "player" | "mob" | "npc" { return "player"; }
  /** Subclass hook to add its own fields to the snapshot. Base: none. */
  protected serializeExtra(_snap: CharacterSnapshot): void {}

  /**
   * Restores this character's state from a snapshot. Items and rooms must
   * already be indexed in `ctx` before calling this. Subclasses restore their
   * own fields via {@link hydrateExtra}.
   *
   * Equipment is populated directly (not via `[EQUIP]`): equip side-effects and
   * derived bonuses are already reflected in the restored base stats and equipped
   * flags, so replaying them would double-apply.
   */
  [HYDRATE](data: CharacterSnapshot, ctx: HydrateContext) {
    this.id = data.id as CharacterId;
    this.name = data.name;
    this.stats = { ...data.stats };
    this.actionsPerRound = data.actionsPerRound;
    this.actionsThisRound = data.actionsThisRound;
    this.archetypeImmunities = [...data.archetypeImmunities];
    this.#currentRoom = data.currentRoomId ? ctx.room(data.currentRoomId) : null;
    this.#inventory.slots = data.inventory.slots;
    this.#inventory.items.length = 0;
    for (const id of data.inventory.itemIds) {
      const item = ctx.item(id);
      this.#inventory.items.push(item);
      item[CLAIM](this);
    }
    this.#inventory.keys.length = 0;
    for (const id of data.inventory.keyIds) {
      const key = ctx.item(id);
      this.#inventory.keys.push(key);
      key[CLAIM](this);
    }
    // Equipment: populate the map directly and mark equipped. Do NOT call [EQUIP]:
    // equip side-effects (and any derived bonuses) are already reflected in the
    // restored base stats / equipped flags, so replaying them would double-apply.
    this.#equipment.clear();
    for (const [slot, itemId] of Object.entries(data.equipment)) {
      const item = ctx.item(itemId);
      this.#equipment.set(slot as EquipmentSlot, item);
      item.properties.equipped = true;
    }
    this.#history = [...data.history];
    this.#afflictions[HYDRATE](data.afflictions);
    this.hydrateExtra(data, ctx);
  }

  /** Subclass hook to restore its own fields. Base: none. */
  protected hydrateExtra(_data: CharacterSnapshot, _ctx: HydrateContext): void {}

  // ---------------------------------------------------------------------------

  /**
   * Crafts the item produced by the recipe identified by `recipeId`. Supports
   * both the materials track (debits the party pool, places the output in an
   * inventory slot) and the key track (consumes held keys, places the output on
   * the keyring). Free action — does not tick the action budget or record history.
   * A Confused fizzle records a `fumble` to history but still does not tick the
   * action budget.
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
