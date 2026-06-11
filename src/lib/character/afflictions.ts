// src/lib/character/afflictions.ts
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in Task 3 (onTurnStart)
import { roll } from "../dice";
import { Status } from "../status";
import type { Stats } from "./stats";

/** The three non-KO statuses that self-clear and can be immunized. */
const CLEARABLE = [Status.Panic, Status.Fear, Status.Confused] as const;
type Clearable = (typeof CLEARABLE)[number];

/** Per-status clear odds (percent, vs a d100) and the Confused fizzle chance. */
export type AfflictionConfig = {
  clear: Record<Clearable, { base: number; increment: number }>;
  confusedFailChance: number;
};

export const DEFAULT_AFFLICTION_CONFIG: AfflictionConfig = {
  clear: {
    [Status.Fear]: { base: 40, increment: 30 },
    [Status.Panic]: { base: 20, increment: 20 },
    [Status.Confused]: { base: 15, increment: 15 },
  },
  confusedFailChance: 50,
};

/** The outcome of gating an attempted action. */
export type GateVerdict =
  | { kind: "allow" }
  | { kind: "fizzle" }
  | { kind: "block"; reason: string };

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in Task 3 (onTurnStart)
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/**
 * Owns a character's status lifecycle: which statuses are active, how long each
 * has been latched (for the increasing clear odds), which were "shaken off" early
 * while their stat is still depleted, and timed immunity counters. All randomness
 * (clear rolls, Confused fizzle) goes through the injected `rng` via {@link roll}.
 */
export class Afflictions {
  // eslint-disable-next-line no-unused-private-class-members -- used in Task 3 (onTurnStart)
  #rng: () => number;
  // eslint-disable-next-line no-unused-private-class-members -- used in Task 3 (onTurnStart)
  #config: AfflictionConfig;
  #active = new Map<Status, boolean>();
  #turnsActive = new Map<Clearable, number>();
  #shakenOff = new Set<Clearable>();
  #immunity = new Map<Clearable, number>();

  constructor(
    rng: () => number = Math.random,
    config: AfflictionConfig = DEFAULT_AFFLICTION_CONFIG,
  ) {
    this.#rng = rng;
    this.#config = config;
    for (const s of [Status.KO, ...CLEARABLE]) this.#active.set(s, false);
  }

  /** The currently-active statuses. */
  get list(): Status[] {
    return [...this.#active.entries()]
      .filter(([, on]) => on)
      .map(([s]) => s);
  }

  /** Whether no status is active. */
  get isNormal(): boolean {
    return [...this.#active.values()].every((on) => !on);
  }

  #immune(s: Clearable, passiveImmune: Set<Status>): boolean {
    return passiveImmune.has(s) || (this.#immunity.get(s) ?? 0) > 0;
  }

  // Drop a status out of its current episode entirely.
  #clearEpisode(s: Clearable) {
    this.#active.set(s, false);
    this.#shakenOff.delete(s);
    this.#turnsActive.set(s, 0);
  }

  // below = stat is past the affliction threshold this resolution.
  #resolve(s: Clearable, below: boolean, passiveImmune: Set<Status>) {
    if (this.#immune(s, passiveImmune) || !below) {
      this.#clearEpisode(s);
      return;
    }
    this.#active.set(s, !this.#shakenOff.has(s));
  }

  /**
   * Recomputes every flag from the current effective stats. Pure: no RNG, no timer
   * mutation. `passiveImmune` is the set of equipment-conferred immunities.
   */
  applyFromStats(effective: Stats, passiveImmune: Set<Status>) {
    if (effective.health <= 0) {
      this.#active.set(Status.KO, true);
      for (const s of CLEARABLE) this.#clearEpisode(s);
      return;
    }
    this.#active.set(Status.KO, false);

    this.#resolve(Status.Panic, effective.sanity <= 0, passiveImmune);
    this.#resolve(
      Status.Fear,
      effective.sanity > 0 && effective.sanity < 5,
      passiveImmune,
    );

    // Confused keeps a (0, 1] hold band so it doesn't flicker near the boundary.
    if (effective.energy <= 0) {
      this.#resolve(Status.Confused, true, passiveImmune);
    } else if (effective.energy > 1) {
      this.#resolve(Status.Confused, false, passiveImmune);
    } else if (this.#immune(Status.Confused, passiveImmune)) {
      this.#clearEpisode(Status.Confused);
    }
  }

  /**
   * Grants timed immunity to `statuses` for `turns` of the character's turns
   * (refreshing to the longer). KO is never immunizable and is ignored. Resets the
   * episode for each granted status so it restarts fresh when immunity lapses.
   */
  grantImmunity(statuses: Status[], turns: number) {
    for (const s of statuses) {
      if (s === Status.KO) continue;
      const clearable = s;
      this.#immunity.set(
        clearable,
        Math.max(this.#immunity.get(clearable) ?? 0, turns),
      );
      this.#clearEpisode(clearable);
    }
  }
}
