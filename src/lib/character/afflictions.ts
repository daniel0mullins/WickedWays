// src/lib/character/afflictions.ts
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

/**
 * Production defaults: Fear 40 %+30/turn (guaranteed turn 3), Panic 20 %+20/turn
 * (guaranteed turn 5), Confused 15 %+15/turn (guaranteed turn 7), Confused fizzle 50 %.
 */
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

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/**
 * Owns a character's status lifecycle: which statuses are active, how long each
 * has been latched (for the increasing clear odds), which were "shaken off" early
 * while their stat is still depleted, and timed immunity counters. All randomness
 * (clear rolls, Confused fizzle) goes through the injected `rng` via {@link roll}.
 */
export class Afflictions {
  #rng: () => number;
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
   * The per-turn time step: roll each active non-KO status for an early clear
   * (chance rises with `turnsActive`), reconcile, then consume one turn of each
   * immunity timer. A status immune this turn is covered before its timer ticks,
   * so a grant of `N` covers the next `N` turns.
   */
  onTurnStart(effective: Stats, passiveImmune: Set<Status>) {
    for (const s of CLEARABLE) {
      if (!this.#active.get(s)) continue;
      const turns = (this.#turnsActive.get(s) ?? 0) + 1;
      this.#turnsActive.set(s, turns);
      const { base, increment } = this.#config.clear[s];
      const p = clamp(base + increment * (turns - 1), 0, 100);
      if (roll(100, this.#rng) <= p) this.#shakenOff.add(s);
    }

    this.applyFromStats(effective, passiveImmune);

    for (const [s, remaining] of [...this.#immunity.entries()]) {
      if (remaining <= 1) this.#immunity.delete(s);
      else this.#immunity.set(s, remaining - 1);
    }
  }

  /**
   * Verdict for an attempted action. Hard blocks (KO, Panic-on-non-move,
   * Fear-on-move) come first; an active Confused then rolls a fizzle. `use` is
   * never gated by the caller, so it never reaches here.
   */
  gate(isMove: boolean): GateVerdict {
    if (this.#active.get(Status.KO)) {
      return { kind: "block", reason: "Cannot act while KO'd." };
    }
    if (this.#active.get(Status.Panic) && !isMove) {
      return { kind: "block", reason: "Panicked: can only move." };
    }
    if (this.#active.get(Status.Fear) && isMove) {
      return { kind: "block", reason: "Too afraid to move." };
    }
    if (this.#active.get(Status.Confused)) {
      if (roll(100, this.#rng) <= this.#config.confusedFailChance) {
        return { kind: "fizzle" };
      }
    }
    return { kind: "allow" };
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
