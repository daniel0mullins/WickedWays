import { describe, it, expect } from "vitest";
import { applyEffect } from "./apply.js";
import { Campaign } from "../campaign.js";
import { PlayerCharacter } from "../character/player-character.js";
import { StatType } from "../character/stats.js";
import { Status } from "../status.js";
import { assignNeutralArchetype } from "../../test-utils.js";

/** Build a started one-PC campaign containing a real PlayerCharacter. */
function makeStartedCampaign() {
  const campaign = new Campaign({ title: "Test" });
  const player = new PlayerCharacter({ campaign, name: "Hero" });
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

  it("adjustStat sanity routes to StatType.Sanity and floors at 0", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "adjustStat", target: player.id, stat: "sanity", delta: -9999 });
    expect(player.effectiveStat(StatType.Sanity)).toBe(0);
  });

  it("adjustStat energy routes to StatType.Energy and floors at 0", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "adjustStat", target: player.id, stat: "energy", delta: -9999 });
    expect(player.effectiveStat(StatType.Energy)).toBe(0);
  });

  it("heal increases health after prior damage", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "damage", target: player.id, amount: 5 });
    const afterDamage = player.effectiveStat(StatType.Health);
    applyEffect(campaign, { kind: "heal", target: player.id, amount: 3 });
    expect(player.effectiveStat(StatType.Health)).toBe(afterDamage + 3);
  });

  it("grantImmunity suppresses active statuses on the next reconcile (isNormal via endTurn)", () => {
    // Deplete sanity fully to trigger Panic, then grant immunity and confirm it
    // clears via the character's public `isNormal` accessor (which reflects
    // `afflictions.isNormal`). endTurn() drives the reconcile while immunity is active.
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "adjustStat", target: player.id, stat: "sanity", delta: -9999 });
    // Force affliction reconcile so Panic latches before immunity is applied.
    player.takeDamage(0, StatType.Sanity);
    expect(player.status).toContain(Status.Panic);

    applyEffect(campaign, { kind: "grantImmunity", target: player.id, turns: 2 });
    // endTurn reconciles afflictions while timed immunity is active — Panic must clear.
    player.endTurn();
    expect(player.isNormal).toBe(true);
  });
});
