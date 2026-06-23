import { describe, it, expect } from "vitest";
import { CampaignRegistry } from "./registry";
import { ProceduralViolation } from "../util";
import type { ICampaign } from "../campaign";

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

describe("CampaignRegistry conditions", () => {
  it("registers and resolves a condition predicate by key", () => {
    const reg = new CampaignRegistry();
    const pred = (_c: ICampaign) => true;
    reg.registerCondition("all-bosses-down", pred);
    expect(reg.condition("all-bosses-down")).toBe(pred);
  });

  it("throws a ProceduralViolation for an unregistered condition key", () => {
    const reg = new CampaignRegistry();
    expect(() => reg.condition("missing")).toThrow(/No condition registered for key 'missing'\./);
  });
});

describe("CampaignRegistry mechanics", () => {
  it("registers and resolves a mechanic by key; throws on miss", () => {
    const reg = new CampaignRegistry();
    const m = { initialState: () => ({}) };
    reg.registerMechanic("doom", m);
    expect(reg.mechanic("doom")).toBe(m);
    expect(() => reg.mechanic("nope")).toThrow(/No mechanic registered/);
  });
});
