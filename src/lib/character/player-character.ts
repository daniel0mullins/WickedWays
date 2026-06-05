import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import { typedEntries, ProceduralViolation } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";

export interface IPlayerCharacter extends ICharacter {
  attack: <C extends ICharacter>(c: C) => void;
  openLootBox: (lootBox: ILoot) => readonly IItem[];
  takeFromLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  putInLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
}

export class PlayerCharacter extends Character implements IPlayerCharacter {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
  ) {
    super(campaign, name, stats, inventorySlots);

    this.isActionMap.set(this.move, true);
    this.isActionMap.set(this.attack, true);
  }

  attack(c: ICharacter) {
    // Find the equipped weapon(s)
    const weapons = this.inventory.items.filter(
      (item) => item.properties.equipped && item.type === "weapon",
    );

    const attackMatrix: Record<StatType, number> = {
      // If there are no equipped weapons, do an unarmed attack against defender health
      [StatType.Health]: weapons.length === 0 ? 1 : 0,
      [StatType.Energy]: 0,
      [StatType.Sanity]: 0,
    };

    // Fill up the attack matrix with a single loop
    weapons.forEach((weapon) => {
      attackMatrix[weapon.stat] += weapon.modifier;
    });

    // Inflict the damage for each stat type to the defender
    for (const [stat, strength] of typedEntries(attackMatrix)) {
      if (strength > 0) {
        c.takeDamage(strength, stat);
      }
    }
    this.recordAction(this.attack);
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
