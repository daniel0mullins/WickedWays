import { describe, it, expect } from "vitest";
import { Resolver } from "./resolver";
import { EntityIndex } from "./entity-index";
import { ProceduralViolation } from "../util";
import { PlayerCharacter } from "../character/player-character";
import { SERIALIZE } from "../serialization/symbols";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";

describe("Resolver.authorize", () => {
  it("accepts a turn-action from the active character", () => {
    const { campaign } = buildStartedCampaign();
    const active = campaign.activeCharacter;
    const r = new Resolver();
    const adjacent = [...active.currentRoom!.exits.values()][0]!.otherSide(active.currentRoom!);
    expect(r.authorize(campaign, { kind: "move", actorId: active.id, roomId: adjacent.id }))
      .toEqual({ ok: true });
  });

  it("rejects a turn-action from a non-active character", () => {
    const { campaign } = buildStartedCampaign();
    const notActive = campaign.party.find((p) => p.id !== campaign.activeCharacter.id)!;
    const r = new Resolver();
    const res = r.authorize(campaign, { kind: "move", actorId: notActive.id, roomId: "r" as never });
    expect(res.ok).toBe(false);
  });

  it("rejects a GM command when there is no GM", () => {
    const { campaign } = buildStartedCampaign({ withGm: false });
    const r = new Resolver();
    expect(r.authorize(campaign, { kind: "nextPlayer" }).ok).toBe(false);
  });

  it("rejects setup after the campaign has started", () => {
    const { campaign } = buildStartedCampaign();
    const r = new Resolver();
    const res = r.authorize(campaign, {
      kind: "selectArchetype", actorId: campaign.activeCharacter.id, archetypeId: "a" as never,
    });
    expect(res.ok).toBe(false);
  });
});

describe("Resolver.apply", () => {
  it("moves the active character to the target room", () => {
    const { campaign } = buildStartedCampaign();
    const active = campaign.activeCharacter;
    const dest = [...active.currentRoom!.exits.values()][0]!.otherSide(active.currentRoom!);
    const index = EntityIndex.fromCampaign(campaign);
    new Resolver().apply(campaign, { kind: "move", actorId: active.id, roomId: dest.id }, index);
    expect(active.currentRoom!.id).toBe(dest.id);
  });

  it("propagates a ProceduralViolation from an illegal engine action", () => {
    const { campaign } = buildStartedCampaign();
    const active = campaign.activeCharacter;
    const index = EntityIndex.fromCampaign(campaign);
    // Moving to a non-adjacent room throws in the engine.
    expect(() =>
      new Resolver().apply(campaign, { kind: "move", actorId: active.id, roomId: "not-adjacent" as never }, index),
    ).toThrow(ProceduralViolation);
  });

  it("joins a brand-new player carried by the command into the party", () => {
    const { campaign } = buildStartedCampaign();
    // Build a bare player off the live campaign, snapshot it, discard the instance.
    const newcomer = new PlayerCharacter({ campaign, name: "Newcomer" });
    const characterSnapshot = newcomer[SERIALIZE]();
    const partyBefore = campaign.party.length;

    const index = EntityIndex.fromCampaign(campaign);
    new Resolver().apply(campaign, { kind: "joinCampaign", character: characterSnapshot }, index);

    expect(campaign.party).toHaveLength(partyBefore + 1);
    expect(campaign.party.some((p) => p.id === characterSnapshot.id)).toBe(true);
  });
});
