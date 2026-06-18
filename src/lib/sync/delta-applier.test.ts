import { describe, it, expect } from "vitest";
import { DeltaApplier } from "./delta-applier";
import { DeltaComputer } from "./delta-computer";
import { serializeCampaign } from "../serialization/serializer";
import { deserializeCampaign } from "../serialization/deserializer";
import {
  buildSerializableCampaign,
  buildStartedCampaign,
  WIDGET_RECIPE_ID,
} from "../serialization/roundtrip.test-helpers";
import type { Campaign } from "../campaign";

/** One real, free engine action that changes a character in place. */
function mutateCampaignForTest(campaign: Campaign): void {
  campaign.party[0]!.takeDamage(1);
}

/** One real engine action that mints a new item (created entity). */
function craftSomethingForTest(campaign: Campaign): void {
  campaign.activeCharacter.craft(WIDGET_RECIPE_ID);
}

describe("DeltaApplier", () => {
  it("applying an action's delta to a replica makes it byte-identical to the source", () => {
    const { campaign, registry } = buildSerializableCampaign();
    const before = serializeCampaign(campaign);
    // Replica B starts from the same 'before' state.
    const replica = deserializeCampaign(before, { registry });

    // Mutate A with a real engine action.
    mutateCampaignForTest(campaign);
    const after = serializeCampaign(campaign);
    const delta = new DeltaComputer().diff(before, after);

    new DeltaApplier().apply(replica, delta, { registry, rng: () => 0.5 });

    expect(serializeCampaign(replica)).toEqual(after);
  });

  it("never draws rng while applying a delta", () => {
    const { campaign, registry } = buildSerializableCampaign();
    const before = serializeCampaign(campaign);
    const replica = deserializeCampaign(before, { registry });
    mutateCampaignForTest(campaign);
    const delta = new DeltaComputer().diff(before, serializeCampaign(campaign));
    const throwingRng = () => {
      throw new Error("rng must not be called during apply");
    };
    expect(() =>
      new DeltaApplier().apply(replica, delta, { registry, rng: throwingRng }),
    ).not.toThrow();
  });

  it("applies a created item (craft) with the same id and registry behavior", () => {
    const { campaign, registry } = buildStartedCampaign();
    const before = serializeCampaign(campaign);
    const replica = deserializeCampaign(before, { registry });
    craftSomethingForTest(campaign);
    const after = serializeCampaign(campaign);
    const delta = new DeltaComputer().diff(before, after);
    expect(delta.created.some((e) => e.type === "item")).toBe(true);
    new DeltaApplier().apply(replica, delta, { registry, rng: () => 0.5 });
    expect(serializeCampaign(replica)).toEqual(after);
  });
});
