import { describe, it, expect } from "vitest";
import { createHollowHouseDirector } from "./audio.js";

const vmWithSanity = (sanity: number) =>
  ({ status: { sanity } } as unknown as import("@wickedways/play-runtime").ViewModel);

describe("Hollow House AudioDirector tension", () => {
  it("is calm (0) at the high-water baseline and rises as sanity falls", () => {
    const d = createHollowHouseDirector();
    expect(d.tension(vmWithSanity(16))).toBe(0);     // sets baseline 16
    expect(d.tension(vmWithSanity(8))).toBeCloseTo(0.5, 5);
    expect(d.tension(vmWithSanity(0))).toBe(1);
  });
  it("keeps the baseline as the max seen (recovering sanity lowers tension, never the baseline)", () => {
    const d = createHollowHouseDirector();
    d.tension(vmWithSanity(10));                      // baseline 10
    d.tension(vmWithSanity(20));                      // baseline rises to 20
    expect(d.tension(vmWithSanity(10))).toBeCloseTo(0.5, 5);
  });
});
