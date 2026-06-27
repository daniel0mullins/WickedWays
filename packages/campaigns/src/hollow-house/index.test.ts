import { describe, it, expect } from "vitest";
import { buildHauntedHouseRegistry, hauntedHouseTemplate } from "./index.js";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { Rooms, Archetypes } from "./ids.js";

describe("haunted house template", () => {
  it("builds without an AuthoringError and seats the player in the Foyer", () => {
    const builder = hauntedHouseTemplate();
    const campaign = startSession(builder, { players: [{ name: "Heir", archetype: Archetypes.Heir }], gm: 0 });
    expect(campaign.activeCharacter.currentRoom?.name).toBe(Rooms.Foyer);
    expect(campaign.maxRounds).toBe(150);
  });
  it("exposes the registry", () => {
    expect(buildHauntedHouseRegistry()).toBeDefined();
  });
});
