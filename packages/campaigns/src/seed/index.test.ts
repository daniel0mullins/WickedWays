import { describe, it, expect } from "vitest";
import { seed } from "./index.js";

describe("seed campaign manifest", () => {
  it("wraps the seed world with no audio/themes (flat-bed path)", () => {
    expect(seed.slug).toBe("seed");
    expect(seed.audio).toBeUndefined();
    expect(seed.themes).toBeUndefined();
    expect(typeof seed.builder).toBe("function");
    expect(typeof seed.registry).toBe("function");
  });

  it("uses the delver archetype defined in the seed world", () => {
    expect(seed.archetype).toBe("delver");
  });

  it("boots the seed world without throwing (archetype validation)", () => {
    // Verify that builder/registry are callable and the template is valid
    const template = seed.builder();
    const registry = seed.registry();
    expect(template).toBeDefined();
    expect(registry).toBeDefined();
  });
});
