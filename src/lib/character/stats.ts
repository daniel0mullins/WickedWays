/**
 * The three core character stats. Each doubles as both a resource pool and the
 * channel an attack can target; depleting one drives the character's
 * {@link Status} conditions.
 */
export const StatType = {
  Energy: "energy",
  Sanity: "sanity",
  Health: "health",
} as const;

/**
 * Maps each stat to the stat that mitigates incoming damage against it,
 * forming a rock-paper-scissors cycle (energy←health←sanity←energy).
 *
 * When a character takes damage to a given stat, the value of its mitigator
 * determines how much of the hit is absorbed. See `Character.takeDamage`.
 */
export const MitigatorStatType = {
  [StatType.Energy]: StatType.Health,
  [StatType.Health]: StatType.Sanity,
  [StatType.Sanity]: StatType.Energy,
} as const;

/** One of the {@link StatType} values (`"energy"`, `"sanity"`, or `"health"`). */
export type StatType = (typeof StatType)[keyof typeof StatType];

/** A character's current value for each {@link StatType}. */
export type Stats = {
  [StatType.Energy]: number;
  [StatType.Sanity]: number;
  [StatType.Health]: number;
};
