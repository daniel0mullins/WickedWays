import { describe, it, expect } from "vitest";
import { DeltaComputer } from "./delta-computer";
import { serializeCampaign } from "../serialization/serializer";
import { buildSerializableCampaign } from "../serialization/roundtrip.test-helpers";
import type { CampaignCoreSnapshot, CampaignSnapshot } from "../serialization/types";
import { DEFAULT_CHAT_POLICY } from "../chat-policy";
import { DEFAULT_AV_POLICY } from "../av-policy";
import { Campaign } from "../campaign";
import { PlayerCharacter } from "../character/player-character";
import { assignNeutralArchetype } from "../../test-utils";
import type { LiveMechanic } from "../mechanics/mechanic";

/** Minimal CampaignCoreSnapshot literal for hand-built snapshot tests. */
function baseCore(): CampaignCoreSnapshot {
  return {
    id: "c-1",
    title: "Test",
    maxRounds: 10,
    round: 1,
    started: false,
    outcome: "ongoing",
    winConditions: [],
    loseConditions: [],
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
    chatPolicy: { ...DEFAULT_CHAT_POLICY },
    avPolicy: { ...DEFAULT_AV_POLICY },
    mechanics: [],
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
    // takeDamage mutates a character snapshot only — campaign core and codex are unchanged.
    expect(delta.campaignCore).toBeUndefined();
  });

  it("captures a created entity", () => {
    const before = { schemaVersion: 1, campaign: baseCore(), rooms: [], characters: [], items: [], loot: [], materialCaches: [], codex: [] } as unknown as CampaignSnapshot;
    const after = { ...before, items: [{ kind: "item", id: "new-1", behaviorKey: "k", modifier: 0 }] } as unknown as CampaignSnapshot;
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.created).toEqual([{ type: "item", data: { kind: "item", id: "new-1", behaviorKey: "k", modifier: 0 } }]);
  });

  it("captures a removed id", () => {
    const after = { schemaVersion: 1, campaign: baseCore(), rooms: [], characters: [], items: [], loot: [], materialCaches: [], codex: [] } as unknown as CampaignSnapshot;
    const before = { ...after, items: [{ kind: "item", id: "gone-1", behaviorKey: "k", modifier: 0 }] } as unknown as CampaignSnapshot;
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.removed).toEqual(["gone-1"]);
  });

  it("captures a campaignCore change when campaign core differs", () => {
    const beforeCampaign = baseCore();
    const afterCampaign = { ...baseCore(), round: 2 };
    const before = { schemaVersion: 1, campaign: beforeCampaign, rooms: [], characters: [], items: [], loot: [], materialCaches: [], codex: [] } as unknown as CampaignSnapshot;
    const after = { ...before, campaign: afterCampaign };
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.campaignCore).toEqual({ core: afterCampaign, codex: [] });
  });

  it("captures a campaignCore change when only the codex differs", () => {
    const campaign = baseCore();
    const codexEntry = { kind: "material", key: "iron", snapshot: { name: "Iron" }, firstSeen: "shop" } as unknown as import("../codex").CodexEntry;
    const before = { schemaVersion: 1, campaign, rooms: [], characters: [], items: [], loot: [], materialCaches: [], codex: [] } as unknown as CampaignSnapshot;
    const after = { ...before, codex: [codexEntry] };
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.campaignCore).toEqual({ core: campaign, codex: [codexEntry] });
  });

  it("mechanic-only state changes produce a campaignCore delta (snapshot decoupled from live state)", () => {
    // Build a started campaign with a doom mechanic (mirrors makeStartedCampaignWithMechanics
    // in campaign.test.ts, inline here to avoid cross-file coupling).
    const mechanic: LiveMechanic = {
      key: "doom",
      mechanic: {
        initialState: () => ({ n: 0 }),
        onRoundEnd: (h) => {
          (h.state as { n: number }).n += 1;
        },
      },
      state: { n: 0 },
    };
    const campaign = new Campaign({ title: "Test", maxRounds: 100, knownRecipes: [], mechanics: [mechanic] });
    const player = new PlayerCharacter({ campaign, name: "Hero" });
    player.joinCampaign();
    assignNeutralArchetype(campaign, player);
    campaign.gm = player;
    campaign.beginCampaign();

    // Take a snapshot BEFORE driving a round that mutates mechanic state.
    const before = serializeCampaign(campaign);

    // Drive a real round: mark the only party member as acted and end the round.
    // onRoundEnd increments doom.n from 0 to 1.
    campaign.nextPlayer();

    // Take the AFTER snapshot.
    const after = serializeCampaign(campaign);

    // The BEFORE snapshot must be decoupled — doom.n must still be 0.
    const beforeMechanic = before.campaign.mechanics.find((m) => m.key === "doom");
    expect(beforeMechanic?.state).toEqual({ n: 0 });

    // The AFTER snapshot reflects the mutation.
    const afterMechanic = after.campaign.mechanics.find((m) => m.key === "doom");
    expect(afterMechanic?.state).toEqual({ n: 1 });

    // DeltaComputer must detect a campaignCore change (not an empty delta).
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.campaignCore).toBeDefined();
    expect(delta.campaignCore?.core.mechanics).toContainEqual({ key: "doom", state: { n: 1 } });
  });
});
