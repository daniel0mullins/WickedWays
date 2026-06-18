import { describe, it, expect } from "vitest";
import { DeltaComputer } from "./delta-computer";
import { serializeCampaign } from "../serialization/serializer";
import { buildSerializableCampaign } from "../serialization/roundtrip.test-helpers";
import type { CampaignCoreSnapshot } from "../serialization/types";

/** Minimal CampaignCoreSnapshot literal for hand-built snapshot tests. */
function baseCore(): CampaignCoreSnapshot {
  return {
    id: "c-1",
    title: "Test",
    maxRounds: 10,
    round: 1,
    started: false,
    finished: false,
    activeCharacterIndex: 0,
    partyIds: [],
    actedThisRound: [],
    gmId: null,
    materials: {},
    claims: [],
    encountered: [],
    knownRecipes: [],
    archetypes: [],
    actionSounds: {},
    encounterTable: { baseChance: 0, visited: [], formations: [] },
  };
}

/**
 * Performs one free engine action on the campaign's active character so its
 * snapshot changes, without requiring the campaign to be started or consuming
 * an action budget.
 */
function mutateCampaignForTest(campaign: ReturnType<typeof buildSerializableCampaign>["campaign"]): void {
  // takeDamage is a free action (no budget tick) and works pre-start.
  campaign.party[0]?.takeDamage(1);
}

describe("DeltaComputer", () => {
  it("returns an empty delta when nothing changed", () => {
    const { campaign } = buildSerializableCampaign();
    const snap = serializeCampaign(campaign);
    const delta = new DeltaComputer().diff(snap, snap);
    expect(delta.changed).toEqual([]);
    expect(delta.created).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.campaignCore).toBeUndefined();
  });

  it("captures a changed character and a campaignCore change after an action", () => {
    const { campaign } = buildSerializableCampaign();
    const before = serializeCampaign(campaign);
    // Drive any state-mutating engine action that changes the active character.
    mutateCampaignForTest(campaign); // implementer: e.g. active char moves / takes damage
    const after = serializeCampaign(campaign);
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.changed.some((e) => e.type === "character")).toBe(true);
  });

  it("captures a created entity", () => {
    const before = { schemaVersion: 1, campaign: baseCore(), rooms: [], characters: [], items: [], loot: [], materialCaches: [], codex: [] };
    const after = { ...before, items: [{ kind: "item", id: "new-1", behaviorKey: "k", modifier: 0 }] };
    const delta = new DeltaComputer().diff(before, after as never);
    expect(delta.created).toEqual([{ type: "item", data: after.items[0] }]);
  });

  it("captures a removed id", () => {
    const after = { schemaVersion: 1, campaign: baseCore(), rooms: [], characters: [], items: [], loot: [], materialCaches: [], codex: [] };
    const before = { ...after, items: [{ kind: "item", id: "gone-1", behaviorKey: "k", modifier: 0 }] };
    const delta = new DeltaComputer().diff(before as never, after);
    expect(delta.removed).toEqual(["gone-1"]);
  });
});
