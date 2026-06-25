import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import type { IRoom } from "../room";
import { ProceduralViolation, typedEntries } from "../util";
import { NOTE_ENCOUNTERS } from "../presentation";
import { RECORD_ENCOUNTER } from "../codex";
import { Combatant, ICombatant } from "./combatant";
import { StatType, type Stats } from "./stats";
import type { AfflictionConfig } from "./afflictions";
import type { Presentation } from "../presentation";
import type { Archetype, ArchetypeId } from "../archetype";
import type { CharacterSnapshot } from "../serialization/types";
import type { HydrateContext } from "../serialization/context";

/**
 * A player-controlled {@link ICombatant}. Adds campaign membership and the
 * ability to interact with loot boxes in the current room.
 */
export interface IPlayerCharacter extends ICombatant {
  /** Adds this character to its campaign's party if not already present. */
  joinCampaign: () => void;
  /** Returns a snapshot of a co-located loot box's contents. */
  openLootBox: (lootBox: ILoot) => readonly IItem[];
  /** Takes item(s) from a loot box into inventory, limited by free slots. */
  takeFromLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  /** Stows item(s) from inventory into a loot box, limited by its capacity. */
  putInLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  /** The archetype this character selected, or `undefined` if none yet. */
  get archetype(): Archetype | undefined;
  /**
   * Selects a campaign-registered archetype, applying its stat and slot deltas
   * once and adopting its standing immunities. Setup-only and once-only.
   */
  selectArchetype: (id: ArchetypeId) => void;
}

/**
 * The baseline stats every player character starts with. The constructor takes
 * no stats: a player character always begins at this baseline, and the only way
 * to start with different values is to {@link PlayerCharacter.selectArchetype}
 * an archetype whose `baseStats` override them.
 */
const DEFAULT_PLAYER_STATS: Readonly<Stats> = Object.freeze({
  [StatType.Health]: 10,
  [StatType.Sanity]: 10,
  [StatType.Energy]: 10,
});

/** Constructor options for a {@link PlayerCharacter}. */
export interface PlayerCharacterOptions {
  /** The campaign the character belongs to. */
  campaign: ICampaign;
  /** Display name. */
  name: string;
  /** Inventory capacity. Defaults to 5. */
  inventorySlots?: number;
  /** Injected randomness for deterministic tests. */
  rng?: () => number;
  /** Overrides the default affliction thresholds/roll config. */
  afflictionConfig?: AfflictionConfig;
  /** Optional presentation metadata (image/sound) for the Play Surface. */
  presentation?: Presentation;
}

/**
 * A player-controlled combatant. Unlike other characters, `move` counts toward
 * its per-turn action budget, and it can open and exchange items with loot boxes
 * in the room it currently occupies.
 */
export class PlayerCharacter extends Combatant implements IPlayerCharacter {
  #archetype?: Archetype;

  get archetype(): Archetype | undefined {
    return this.#archetype;
  }

  /** See {@link Character} for parameters; also registers `move` as a budgeted action. */
  constructor(opts: PlayerCharacterOptions) {
    super({
      campaign: opts.campaign,
      name: opts.name,
      stats: { ...DEFAULT_PLAYER_STATS },
      inventorySlots: opts.inventorySlots ?? 5,
      actionsPerRound: 3,
      rng: opts.rng,
      afflictionConfig: opts.afflictionConfig,
      presentation: opts.presentation,
    });

    // `this.move` is the override (PlayerCharacter.prototype.move); super.move's
    // recordAction(this.move, …) resolves to that same override, so the budget ticks.
    this.isActionMap.set(this.move, true);
    // `go` delegates to `this.move` (which records the "move" action); registering
    // `go` here makes its attemptAction fizzle tick the budget, matching `move`.
    this.isActionMap.set(this.go, true);
  }

  // ---------------------------------------------------------------------------
  // Serialization hooks
  // ---------------------------------------------------------------------------

  protected override serializeKind(): "player" | "mob" { return "player"; }

  protected override serializeExtra(snap: CharacterSnapshot): void {
    if (this.#archetype) snap.archetypeId = this.#archetype.id;
  }

  protected override hydrateExtra(data: CharacterSnapshot, _ctx: HydrateContext): void {
    if (data.archetypeId) {
      const archetype = this.campaign.archetypes.get(data.archetypeId as ArchetypeId);
      if (!archetype) throw new ProceduralViolation(`Unknown archetype '${data.archetypeId}' on restore.`);
      this.#archetype = archetype;
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Selects an archetype from the campaign catalog, applying its effects exactly
   * once: the named stats override the base stats, the slot delta adjusts
   * inventory capacity (floored at 0), and the immunities become a standing
   * passive trait. A setup-only, once-only operation.
   *
   * @param id - The id of an archetype registered on the campaign.
   * @throws {@link ProceduralViolation} if the campaign has already begun, an
   *   archetype is already selected, or `id` is not in the catalog.
   */
  selectArchetype(id: ArchetypeId) {
    if (this.campaign.started) {
      throw new ProceduralViolation(
        "Cannot select an archetype after the campaign has begun.",
      );
    }
    if (this.#archetype) {
      throw new ProceduralViolation(
        "Character has already selected an archetype.",
      );
    }
    const archetype = this.campaign.archetypes.get(id);
    if (!archetype) {
      throw new ProceduralViolation("Unknown archetype.");
    }

    if (archetype.baseStats) {
      for (const [stat, value] of typedEntries(archetype.baseStats) as Array<
        [StatType, number | undefined]
      >) {
        if (value === undefined) continue;
        this.stats[stat] = value;
      }
    }
    if (archetype.inventorySlots !== undefined) {
      // `inventory` returns the live inventory object, so this mutates capacity.
      this.inventory.slots = Math.max(0, this.inventory.slots + archetype.inventorySlots);
    }

    this.#archetype = archetype;
    this.archetypeImmunities = archetype.immunities ?? [];
  }

  /**
   * Moves as a {@link Character}, then runs the campaign's encounter spawn check
   * on the room actually entered. If the move was blocked or fizzled (current
   * room unchanged), no spawn check runs.
   *
   * @param room - Destination room.
   */
  override move(room: IRoom) {
    super.move(room);
    if (this.currentRoom === room) {
      this.campaign.maybeSpawn(room);
      this.campaign[NOTE_ENCOUNTERS](this, room);
      this.campaign[RECORD_ENCOUNTER]({ kind: "room", room }, this, room);
    }
  }

  /** Joins the character's campaign party, ignoring a repeated join. */
  joinCampaign() {
    const { party } = this.campaign;
    if (!party.includes(this)) {
      party.push(this);
    }
  }

  #requireCoLocated(lootBox: ILoot) {
    if (!this.currentRoom?.loot.has(lootBox.id)) {
      throw new ProceduralViolation(
        "Cannot interact with a loot box that is not in the current room",
      );
    }
  }

  /**
   * Returns a snapshot of the loot box's contents.
   *
   * @param lootBox - The box to inspect; must be in the current room.
   * @returns A copy of the box's current contents.
   * @throws {@link ProceduralViolation} if the box is not in the current room.
   */
  openLootBox(lootBox: ILoot): readonly IItem[] {
    this.#requireCoLocated(lootBox);
    return [...lootBox.contents];
  }

  /**
   * Moves item(s) from the loot box into this character's inventory, taking only
   * those actually present in the box and only as many as there are free slots.
   * Recorded as a single `pickUp` action.
   *
   * @param lootBox - The box to take from; must be in the current room.
   * @param item - The item(s) requested.
   * @returns The items actually transferred.
   * @throws {@link ProceduralViolation} if the box is not in the current room.
   */
  takeFromLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    if (!this.attemptAction(this.takeFromLootBox, false)) return [];
    this.requireVisibleTarget("loot");
    this.#requireCoLocated(lootBox);
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      lootBox.contents.some((boxItem) => boxItem.id === requestedItem.id),
    );
    const free = this.inventory.slots - this.inventory.items.length;
    const toTake = present.slice(0, free);
    const removed = lootBox.removeItems(toTake.map((taken) => taken.id));
    if (removed.length > 0) {
      this.withGateSuppressed(() =>
        this.withCueSound(lootBox.presentation?.sound, () =>
          this.addToInventory(removed),
        ),
      );
    }
    return removed;
  }

  /**
   * Moves item(s) from this character's inventory into the loot box, stowing
   * only those actually held and only as many as the box's remaining capacity
   * allows. Recorded as a single `drop` action.
   *
   * @param lootBox - The box to stow into; must be in the current room.
   * @param item - The item(s) requested.
   * @returns The items actually stowed.
   * @throws {@link ProceduralViolation} if the box is not in the current room.
   * @throws {@link ProceduralViolation} if any item is a key.
   */
  putInLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    if (!this.attemptAction(this.putInLootBox, false)) return [];
    this.#requireCoLocated(lootBox);
    const requested = Array.isArray(item) ? item : [item];
    if (requested.some((i) => i.type === "key")) {
      throw new ProceduralViolation(
        "Keys cannot be stored in a loot container.",
      );
    }
    const present = requested.filter((requestedItem) =>
      this.inventory.items.some((held) => held.id === requestedItem.id),
    );
    const free = lootBox.capacity - lootBox.contents.length;
    const toPut = present.slice(0, free);
    if (toPut.length > 0) {
      this.withGateSuppressed(() =>
        this.withCueSound(lootBox.presentation?.sound, () =>
          this.removeFromInventory(toPut),
        ),
      );
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
    return toPut;
  }
}
