import { ICampaign } from "../campaign";
import { typedEntries } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";

export interface ICombatant extends ICharacter {
  attack: <C extends ICharacter>(c: C) => void;
}

export abstract class Combatant extends Character implements ICombatant {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
  ) {
    super(campaign, name, stats, inventorySlots, actionsPerRound);
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
}
