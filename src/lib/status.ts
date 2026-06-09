/**
 * Adverse conditions a character can be afflicted with.
 *
 * Statuses are derived from a character's stats during turn resolution: KO when
 * health is depleted, Confused when energy is depleted, and Panic/Fear at low
 * sanity. See {@link Character} for how each is set.
 */
export const Status = {
  KO: "ko",
  Panic: "panic",
  Confused: "confused",
  Fear: "fear",
} as const;

/** One of the {@link Status} condition values (e.g. `"ko"`, `"panic"`). */
export type Status = (typeof Status)[keyof typeof Status];

/**
 * Per-character map recording whether each {@link Status} is currently active.
 * A status is considered absent when its entry is `false`.
 */
export type StatusMatrix = Map<Status, boolean>;
