import { describe, it, expect } from "vitest";
import { assemble } from "./assembler";
import { AuthoringError } from "./errors";
import { DEFAULT_AV_POLICY } from "../av-policy";
import { defineRegistry } from "./registry";
import type { CampaignTemplateDescription } from "./description";

const registry = defineRegistry({ items: {} });

const base: CampaignTemplateDescription = {
  title: "T", opts: {}, archetypes: [], rooms: [{ name: "R", description: "d" }],
  startRoom: "R", exits: [], mobs: [], loot: [], caches: [], recipes: [],
  materials: [], winConditions: [], loseConditions: [], mechanics: [],
};

describe("assemble() av policy", () => {
  it("defaults to DEFAULT_AV_POLICY when av is omitted", () => {
    expect(assemble(base, registry).campaign.avPolicy).toEqual(DEFAULT_AV_POLICY);
  });

  it("applies an authored disabled policy", () => {
    const desc = { ...base, av: { ...DEFAULT_AV_POLICY, enabled: false } };
    expect(assemble(desc, registry).campaign.avPolicy.enabled).toBe(false);
  });

  it("rejects a non-positive maxParticipants", () => {
    const desc = { ...base, av: { ...DEFAULT_AV_POLICY, maxParticipants: 0 } };
    expect(() => assemble(desc, registry)).toThrow(AuthoringError);
  });
});
