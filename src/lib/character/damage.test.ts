import { describe, expect, it } from "vitest";
import { computeMitigatedDamage } from "./damage";

describe("computeMitigatedDamage", () => {
  it("armor soaks raw strength before mitigation", () => {
    // strength 10, armor 4 → mitigatedStrength 6; mitigator 0 → multiplier 10*0.2=2; no light
    expect(
      computeMitigatedDamage({ attackStrength: 10, armorSum: 4, mitigator: 0, lightAverse: false, roomLit: false }),
    ).toBe(12);
  });

  it("a full mitigator (>= MAX_STAT) absorbs the hit entirely", () => {
    expect(
      computeMitigatedDamage({ attackStrength: 10, armorSum: 0, mitigator: 10, lightAverse: false, roomLit: false }),
    ).toBe(0);
  });

  it("light-averse in a lit room multiplies by LIGHT_VULNERABILITY", () => {
    // mitigatedStrength 5, mitigator 5 → multiplier 5*0.2=1; light 1.5 → 7.5
    expect(
      computeMitigatedDamage({ attackStrength: 5, armorSum: 0, mitigator: 5, lightAverse: true, roomLit: true }),
    ).toBe(7.5);
  });

  it("never returns negative when armor exceeds strength", () => {
    expect(
      computeMitigatedDamage({ attackStrength: 3, armorSum: 9, mitigator: 0, lightAverse: false, roomLit: false }),
    ).toBe(0);
  });
});
