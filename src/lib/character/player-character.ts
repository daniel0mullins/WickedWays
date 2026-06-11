import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import type { IRoom } from "../room";
import { ProceduralViolation } from "../util";
import { Combatant, ICombatant } from "./combatant";
import { Stats } from "./stats";
import type { AfflictionConfig } from "./afflictions";

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
}

/**
 * A player-controlled combatant. Unlike other characters, `move` counts toward
 * its per-turn action budget, and it can open and exchange items with loot boxes
 * in the room it currently occupies.
 */
export class PlayerCharacter extends Combatant implements IPlayerCharacter {
  /** See {@link Character} for parameters; also registers `move` as a budgeted action. */
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    super(campaign, name, stats, inventorySlots, 3, options);

    this.isActionMap.set(this.move, true);
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
    this.#requireCoLocated(lootBox);
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      lootBox.contents.some((boxItem) => boxItem.id === requestedItem.id),
    );
    const free = this.inventory.slots - this.inventory.items.length;
    const toTake = present.slice(0, free);
    const removed = lootBox.removeItems(toTake.map((taken) => taken.id));
    if (removed.length > 0) {
      this.withGateSuppressed(() => this.addToInventory(removed));
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
      this.withGateSuppressed(() => this.removeFromInventory(toPut));
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
    return toPut;
  }
}
