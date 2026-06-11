import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { roll } from "../dice";
import { clamp } from "../util";
import { Combatant, ICombatant } from "./combatant";
import { Stats, StatType } from "./stats";
import type { AfflictionConfig } from "./afflictions";

/** A non-player {@link ICombatant}, such as an enemy, that can also flee. */
export interface IMob extends ICombatant {
  /** Attempts a Health-gated flee through a random exit, recording an `escape`. */
  escape: () => void;
}

/**
 * A hostile, non-player combatant. Carries `drops` (items released on defeat)
 * and can {@link Mob.escape}. Inventory is sized to hold at least its drops.
 */
export class Mob extends Combatant implements IMob {
  /** Base escape chance before the Health bonus; 0–100. */
  #baseEscapeChance: number;

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
    options: {
      rng?: () => number;
      afflictionConfig?: AfflictionConfig;
      baseEscapeChance?: number;
    } = {},
  ) {
    const _inventorySlots = Math.max(inventorySlots, drops.length);
    super(campaign, name, stats, _inventorySlots, actionsPerRound, options);

    this.#baseEscapeChance = options.baseEscapeChance ?? 50;
    this.isActionMap.set(this.escape, true);
  }

  /**
   * Attempts to flee the current room. Success is a Health-gated roll:
   * `roll(100) <= clamp(baseEscapeChance + effective Health, 0, 100)` *and* an
   * exit must exist. On success the mob moves through a randomly chosen exit
   * (gate-suppressed, so it does not consume a second action). Whether it
   * succeeds or fails, the `escape` action is recorded and the budget ticks.
   */
  escape() {
    if (!this.attemptAction(this.escape, false)) return;
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const threshold = clamp(
      this.#baseEscapeChance + this.effectiveStat(StatType.Health),
      0,
      100,
    );
    const rolled = roll(100, this.rng) <= threshold;
    const success = rolled && exits.length > 0;
    if (success) {
      const destination = exits[roll(exits.length, this.rng) - 1]!;
      this.withGateSuppressed(() => this.move(destination));
    }
    this.recordAction(this.escape, { kind: "escape", success });
  }
}
