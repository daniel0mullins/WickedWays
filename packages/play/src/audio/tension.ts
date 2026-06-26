/**
 * Map current sanity to an ambient tension value in `[0, 1]`, normalized against
 * a baseline (the high-water mark of sanity seen this session). High sanity →
 * 0 (calm/consonant); zero sanity → 1 (dissonant/tense).
 */
export function sanityToTension(current: number, baseline: number): number {
  if (baseline <= 0) return 0;
  const ratio = current / baseline;
  return Math.min(1, Math.max(0, 1 - ratio));
}
