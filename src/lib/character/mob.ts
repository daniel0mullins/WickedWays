import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { Combatant, ICombatant } from "./combatant";
import { Stats } from "./stats";
import type { AfflictionConfig } from "./afflictions";

/** A non-player {@link ICombatant}, such as an enemy, that can also flee. */
export interface IMob extends ICombatant {
  /** Flees through the first available exit, recording an `escape` action. */
  escape: () => void;
}

/**
 * A hostile, non-player combatant. Carries `drops` (items released on defeat)
 * and can {@link Mob.escape}. Inventory is sized to hold at least its drops.
 */
export class Mob extends Combatant implements IMob {
  /**
   * @param campaign - The campaign the mob belongs to.
   * @param name - Display name.
   * @param stats - Initial {@link Stats}.
   * @param inventorySlots - Inventory capacity; raised to fit `drops`. Defaults to 2.
   * @param actionsPerRound - Budgeted actions per turn. Defaults to 2.
   * @param drops - Items the mob carries (and can drop).
   */
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 2,
    actionsPerRound: number = 2,
    drops: IItem[],
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    const _inventorySlots = Math.max(inventorySlots, drops.length);
    super(campaign, name, stats, _inventorySlots, actionsPerRound, options);

    this.isActionMap.set(this.escape, true);
  }

  /**
   * Attempts to flee through the first available exit of the current room.
   *
   * The `escape` action is always recorded (it consumes the action) even when
   * there is no exit to flee through. A successful flee additionally moves the
   * mob via {@link Character.move}; because `Mob` does not register `move` as an
   * action, that move does not consume a second action.
   */
  escape() {
    // Flee through the first available exit. The move() transition fires the
    // room's exit/enter scenes; because Mob does not register `move`, that
    // call does not consume an action — `escape` is the recorded action.
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const destination = exits[0];
    if (destination) {
      this.move(destination);
    }
    // The escape attempt is always recorded (it consumed the action), even when
    // there was no exit to flee through; a successful flee also records the
    // `move` separately via move() above.
    this.recordAction(this.escape, { kind: "escape" });
  }
}
