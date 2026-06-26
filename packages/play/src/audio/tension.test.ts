import { describe, it, expect } from "vitest";
import { sanityToTension } from "./tension.js";

describe("sanityToTension", () => {
  it("is calm (0) at or above baseline", () => {
    expect(sanityToTension(16, 16)).toBe(0);
    expect(sanityToTension(20, 16)).toBe(0);
  });
  it("is fully tense (1) at zero sanity", () => {
    expect(sanityToTension(0, 16)).toBe(1);
  });
  it("rises monotonically as sanity falls", () => {
    expect(sanityToTension(12, 16)).toBeLessThan(sanityToTension(4, 16));
  });
  it("clamps to [0,1] and guards a non-positive baseline", () => {
    expect(sanityToTension(-5, 16)).toBe(1);
    expect(sanityToTension(5, 0)).toBe(0);
  });
});
