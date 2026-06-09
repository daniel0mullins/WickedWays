import { ICampaign } from "../campaign";
import { typedEntries } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";

/** A {@link ICharacter} that can attack other characters. */
export interface ICombatant extends ICharacter {
  /** Attacks `c`, dealing weapon- or unarmed-based damage. */
  attack: <C extends ICharacter>(c: C) => void;
}

/**
 * Abstract base for characters that fight. Adds the {@link Combatant.attack}
 * action (registered as a budgeted action) on top of {@link Character}.
 */
export abstract class Combatant extends Character implements ICombatant {
  /** See {@link Character} for parameter details; also registers `attack` as an action. */
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

  /**
   * Attacks `c`. Each equipped weapon contributes its modifier to its stat; with
   * no weapon equipped, a strength-1 unarmed strike lands against the defender's
   * health. Damage is then applied per stat via {@link Character.takeDamage} and
   * an `attack` action is recorded.
   *
   * @param c - The character being attacked.
   */
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
    this.recordAction(this.attack, {
      kind: "attack",
      target: { id: c.id, name: c.name },
    });
  }
}
