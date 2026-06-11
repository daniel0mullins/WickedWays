import { describe, expect, it } from "vitest";
import { roll } from "./dice";

describe("roll", () => {
  it("returns 1 for the bottom of the range", () => {
    expect(roll(6, () => 0)).toBe(1);
  });

  it("returns `sides` for the top of the range", () => {
    expect(roll(6, () => 0.999)).toBe(6);
    expect(roll(100, () => 0.999)).toBe(100);
  });

  it("defaults to a d100", () => {
    expect(roll(undefined, () => 0.5)).toBe(51);
  });

  it("never escapes [1, sides] across the unit interval", () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999999]) {
      const v = roll(20, () => r);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });
});
