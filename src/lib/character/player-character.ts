import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import { ProceduralViolation } from "../util";
import { Combatant, ICombatant } from "./combatant";
import { Stats } from "./stats";

export interface IPlayerCharacter extends ICombatant {
  joinCampaign: () => void;
  openLootBox: (lootBox: ILoot) => readonly IItem[];
  takeFromLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  putInLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
}

export class PlayerCharacter extends Combatant implements IPlayerCharacter {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
  ) {
    super(campaign, name, stats, inventorySlots);

    this.isActionMap.set(this.move, true);
  }

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

  openLootBox(lootBox: ILoot): readonly IItem[] {
    this.#requireCoLocated(lootBox);
    return [...lootBox.contents];
  }

  takeFromLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    this.#requireCoLocated(lootBox);
    // Reuse removeItems + addToInventory rather than the raw holder primitives:
    // addToInventory already fires pickUp and records exactly one action.
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      lootBox.contents.some((boxItem) => boxItem.id === requestedItem.id),
    );
    const free = this.inventory.slots - this.inventory.items.length;
    const toTake = present.slice(0, free);
    const removed = lootBox.removeItems(toTake.map((taken) => taken.id));
    if (removed.length > 0) {
      this.addToInventory(removed);
    }
    return removed;
  }

  putInLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    this.#requireCoLocated(lootBox);
    // Reuse removeFromInventory + stowItem rather than the raw holder primitives:
    // removeFromInventory records exactly one action; stowItem re-claims the box as holder.
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      this.inventory.items.some((held) => held.id === requestedItem.id),
    );
    const free = lootBox.capacity - lootBox.contents.length;
    const toPut = present.slice(0, free);
    if (toPut.length > 0) {
      this.removeFromInventory(toPut);
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
    return toPut;
  }
}
