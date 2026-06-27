import { describe, it, expect } from "vitest";
import { hollowHouseThemes, hauntedCrtTheme } from "./themes.js";

describe("Hollow House themes", () => {
  it("ships two distinct themes, default first", () => {
    expect(hollowHouseThemes).toHaveLength(2);
    expect(hollowHouseThemes[0]!.id).toBe("default");
    expect(hollowHouseThemes[1]!.id).toBe("haunted");
  });
  it("the haunted theme is a darker, heavier-glow reskin", () => {
    expect(hauntedCrtTheme.palette.fg).not.toBe(hollowHouseThemes[0]!.palette.fg);
    expect(hauntedCrtTheme.effects.glow).toBeGreaterThan(hollowHouseThemes[0]!.effects.glow);
    expect(hauntedCrtTheme.effects.flicker).toBeGreaterThan(0);
  });
});
