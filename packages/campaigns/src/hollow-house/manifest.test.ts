import { describe, it, expect } from "vitest";
import { hollowHouse } from "./manifest.js";

describe("hollowHouse manifest", () => {
  it("declares identity + factories that build fresh each call", () => {
    expect(hollowHouse.slug).toBe("hollow-house");
    expect(hollowHouse.title).toBe("The Hollow House");
    expect(hollowHouse.blurb.length).toBeGreaterThan(0);
    expect(hollowHouse.playerName).toBe("Heir");
    expect(hollowHouse.archetype).toBe("heir");
    // factories return new instances
    expect(hollowHouse.builder()).not.toBe(hollowHouse.builder());
    expect(hollowHouse.registry()).not.toBe(hollowHouse.registry());
  });
});
