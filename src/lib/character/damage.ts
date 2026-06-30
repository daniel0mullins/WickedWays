/** Damage mitigation: a mitigating stat of MAX_STAT fully absorbs the hit, while
 *  a mitigator of 0 doubles it. Each point of the mitigating stat removes
 *  MITIGATION_PER_POINT of the incoming damage multiplier. */
export const MAX_STAT = 10;
export const MITIGATION_PER_POINT = 0.2;
/** Damage multiplier applied to a light-averse creature while its room is lit. */
export const LIGHT_VULNERABILITY = 1.5;

/** Pure inputs to the mitigation formula (pre-mechanics-transform). */
export interface DamageInput {
  attackStrength: number;
  armorSum: number;
  mitigator: number;
  lightAverse: boolean;
  roomLit: boolean;
}

/** The pure damage-mitigation formula from `Character.takeDamage`, extracted so
 *  it is independently testable and can serve as the conformance oracle. */
export function computeMitigatedDamage(input: DamageInput): number {
  const mitigatedStrength = Math.max(0, input.attackStrength - input.armorSum);
  const damageMultiplier = Math.max(0, MAX_STAT - input.mitigator) * MITIGATION_PER_POINT;
  const lightMultiplier = input.lightAverse && input.roomLit ? LIGHT_VULNERABILITY : 1;
  return mitigatedStrength * damageMultiplier * lightMultiplier;
}
