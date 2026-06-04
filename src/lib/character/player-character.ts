import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import { typedEntries } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";

export interface IPlayerCharacter extends ICharacter {
  attack: <C extends ICharacter>(c: C) => void;
  openLootBox: (lootBox: ILoot) => IItem[];
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
    this.isActionMap.set(this.openLootBox, true);
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
      attackMatrix[weapon.stat] = attackMatrix[weapon.stat] += weapon.modifier;
    });

    // Inflict the damage for each stat type to the defender
    for (const [stat, strength] of typedEntries(attackMatrix)) {
      if (strength > 0) {
        c.takeDamage(strength, stat);
      }
    }
    this.recordAction(this.attack);
  }

  openLootBox(lootBox: ILoot) {
    const { contents } = lootBox;
    this.recordAction(this.openLootBox);
    return contents;
  }
}
