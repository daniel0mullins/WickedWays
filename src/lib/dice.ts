/**
 * Rolls a single die with `sides` faces, returning an integer in `[1, sides]`.
 *
 * The standard TTRPG die. Defaults to a d100 (percentile). `rng` is injectable
 * for deterministic tests and defaults to `Math.random`; it must yield a float in
 * `[0, 1)`.
 *
 * @param sides - Number of faces. Defaults to 100.
 * @param rng - Float source in `[0, 1)`. Defaults to `Math.random`.
 * @returns An integer in `[1, sides]`.
 */
export function roll(sides: number = 100, rng: () => number = Math.random): number {
  return Math.floor(rng() * sides) + 1;
}
