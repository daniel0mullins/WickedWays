import { ICampaign } from "../campaign";
import { SET_DURABILITY } from "../inventory";
import { typedEntries } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";
import type { AfflictionConfig } from "./afflictions";

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
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    super(campaign, name, stats, inventorySlots, actionsPerRound, options);
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
    // Only intact (non-broken) equipped weapons fight; broken ones contribute nothing.
    const weapons = this.inventory.items.filter(
      (item) => item.properties.equipped && item.type === "weapon" && !item.isBroken,
    );

    const attackMatrix: Record<StatType, number> = {
      // If there are no usable weapons, do an unarmed attack against defender health
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

    // Each weapon that swung wears one point (non-durable weapons are untouched).
    weapons.forEach((weapon) => {
      if (weapon.maxDurability !== undefined) {
        // durability is defined whenever maxDurability is (see Item constructor).
        weapon[SET_DURABILITY](weapon.durability! - 1);
      }
    });

    this.recordAction(this.attack, {
      kind: "attack",
      target: { id: c.id, name: c.name },
    });
  }
}
