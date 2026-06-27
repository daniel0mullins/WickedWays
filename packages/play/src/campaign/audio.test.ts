import { describe, it, expect } from "vitest";
import { createHollowHouseDirector } from "./audio.js";

function campaignWithSanity(s: number) {
  return { party: [{ effectiveStat: () => s }] } as never;
}

describe("Hollow House AudioDirector tension", () => {
  it("is calm (0) at the high-water baseline and rises as sanity falls", () => {
    const d = createHollowHouseDirector();
    expect(d.tension(campaignWithSanity(16))).toBe(0);     // sets baseline 16
    expect(d.tension(campaignWithSanity(8))).toBeCloseTo(0.5, 5);
    expect(d.tension(campaignWithSanity(0))).toBe(1);
  });
  it("keeps the baseline as the max seen (recovering sanity lowers tension, never the baseline)", () => {
    const d = createHollowHouseDirector();
    d.tension(campaignWithSanity(10));                      // baseline 10
    d.tension(campaignWithSanity(20));                      // baseline rises to 20
    expect(d.tension(campaignWithSanity(10))).toBeCloseTo(0.5, 5);
  });
});
