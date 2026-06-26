import { SET_DURABILITY } from "../inventory";
import { typedEntries } from "../util";
import { Character, CharacterOptions, ICharacter } from "./character";
import { StatType } from "./stats";

/** A combatant's innate strike when wielding no weapon: which stat it hits and how hard. */
export interface NaturalAttack {
  stat: StatType;
  power: number;
}

/** The default natural attack: a 1-point unarmed strike against Health. */
export const DEFAULT_NATURAL_ATTACK: NaturalAttack = { stat: StatType.Health, power: 1 };

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
  /** See {@link CharacterOptions} for parameter details; also registers `attack` as an action. */
  constructor(opts: CharacterOptions) {
    super(opts);
    this.isActionMap.set(this.attack, true);
  }

  /**
   * The combatant's unarmed strike — which stat it hits and how hard, used when
   * no weapon is equipped. Defaults to a 1-point Health jab; {@link Mob} overrides
   * it so resident horrors can claw Sanity, batter Health, etc.
   */
  protected get naturalAttack(): NaturalAttack {
    return DEFAULT_NATURAL_ATTACK;
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
    if (!this.attemptAction(this.attack, false)) return;
    this.requireVisibleTarget("attack");
    // Only intact (non-broken) equipped weapons fight; broken ones contribute nothing.
    const weapons = this.inventory.items.filter(
      (item) => item.properties.equipped && item.type === "weapon" && !item.isBroken,
    );

    const attackMatrix: Record<StatType, number> = {
      [StatType.Health]: 0,
      [StatType.Energy]: 0,
      [StatType.Sanity]: 0,
    };

    if (weapons.length === 0) {
      // No weapon: fall back to the combatant's natural attack (default: 1 Health).
      const natural = this.naturalAttack;
      attackMatrix[natural.stat] += natural.power;
    } else {
      // Each equipped weapon adds its modifier to the stat it targets.
      weapons.forEach((weapon) => {
        attackMatrix[weapon.stat] += weapon.modifier;
      });
    }

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
