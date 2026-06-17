import { describe, it, expect } from "vitest";
import { CampaignRegistry } from "./registry";
import { ProceduralViolation } from "../util";

describe("CampaignRegistry", () => {
  it("returns a registered scene behavior", () => {
    const reg = new CampaignRegistry();
    const behavior = { preconditions: [], script: () => {} };
    reg.registerScene("crypt-trap", behavior);
    expect(reg.scene("crypt-trap")).toBe(behavior);
  });

  it("throws ProceduralViolation on an unknown key", () => {
    const reg = new CampaignRegistry();
    expect(() => reg.scene("missing")).toThrow(ProceduralViolation);
  });
});
