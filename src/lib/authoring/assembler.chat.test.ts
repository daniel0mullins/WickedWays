import { describe, it, expect } from "vitest";
import { assemble } from "./assembler";
import { AuthoringError } from "./errors";
import { DEFAULT_CHAT_POLICY } from "../chat-policy";
import { defineRegistry } from "./registry";
import type { CampaignTemplateDescription } from "./description";

const registry = defineRegistry({ items: {} });

const base: CampaignTemplateDescription = {
  title: "T", opts: {}, archetypes: [], rooms: [{ name: "R", description: "d" }],
  startRoom: "R", exits: [], mobs: [], loot: [], caches: [], npcs: [], formations: [], scenes: [], recipes: [],
  materials: [], winConditions: [], loseConditions: [], mechanics: [],
};

describe("assemble() chat policy", () => {
  it("defaults to DEFAULT_CHAT_POLICY when chat is omitted", () => {
    expect(assemble(base, registry).campaign.chatPolicy).toEqual(DEFAULT_CHAT_POLICY);
  });

  it("applies an authored single-player (disabled) policy", () => {
    const desc = { ...base, chat: { ...DEFAULT_CHAT_POLICY, enabled: false } };
    expect(assemble(desc, registry).campaign.chatPolicy.enabled).toBe(false);
  });

  it("rejects a non-positive backfillWindow", () => {
    const desc = { ...base, chat: { ...DEFAULT_CHAT_POLICY, backfillWindow: 0 } };
    expect(() => assemble(desc, registry)).toThrow(AuthoringError);
  });
});
