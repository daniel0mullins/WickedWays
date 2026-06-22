import { describe, it, expect } from "vitest";
import { applyEffect } from "./apply.js";
import { Campaign } from "../campaign.js";
import { PlayerCharacter } from "../character/player-character.js";
import { StatType } from "../character/stats.js";
import { makeStats, assignNeutralArchetype } from "../../test-utils.js";

/** Build a started one-PC campaign containing a real PlayerCharacter. */
function makeStartedCampaign() {
  const campaign = new Campaign("Test");
  const player = new PlayerCharacter(campaign, "Hero", makeStats());
  player.joinCampaign();
  assignNeutralArchetype(campaign, player);
  campaign.gm = player;
  campaign.beginCampaign();
  return { campaign, player };
}

describe("applyEffect", () => {
  it("damage floors the target's health at 0 and never goes negative", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "damage", target: player.id, amount: 9999 });
    expect(player.effectiveStat(StatType.Health)).toBe(0);
  });

  it("rejects negative amounts by clamping to 0 (no healing via damage)", () => {
    const { campaign, player } = makeStartedCampaign();
    const before = player.effectiveStat(StatType.Health);
    applyEffect(campaign, { kind: "damage", target: player.id, amount: -5 });
    expect(player.effectiveStat(StatType.Health)).toBe(before);
  });

  it("emits a mechanic cue", () => {
    const { campaign } = makeStartedCampaign();
    const cues: unknown[] = [];
    campaign.onCue((c) => cues.push(c));
    applyEffect(campaign, { kind: "cue", cue: { text: "tick" } });
    expect(cues).toContainEqual({ kind: "mechanic", cue: { text: "tick" } });
  });
});
