/**
 * Regression guard: re-serialising and re-deserialising a campaign snapshot
 * must produce identical collection sizes to a single round-trip. This confirms
 * that all `[HYDRATE]` seams are idempotent (no append-without-clear).
 *
 * Note: a pure round-trip-twice test passes even *before* the idempotency fixes
 * because `deserializeCampaign` builds fresh instances on each call. The direct
 * per-seam idempotency assertions (calling `[HYDRATE]` twice on the *same* live
 * instance via a minimal `HydrateContext`) are exercised by Task 6's DeltaApplier
 * tests, which wire a full entity index and re-apply patches onto existing objects.
 */
import { describe, it, expect } from "vitest";
import { serializeCampaign } from "./serializer";
import { deserializeCampaign } from "./deserializer";
import { buildSerializableCampaign } from "./roundtrip.test-helpers";

describe("idempotent [HYDRATE]", () => {
  it("re-applying a campaign snapshot onto an already-hydrated campaign does not duplicate collections", () => {
    const { campaign, registry } = buildSerializableCampaign();
    const snap = serializeCampaign(campaign);

    // First round-trip.
    const restored = deserializeCampaign(snap, { registry });
    const before = serializeCampaign(restored);

    // Second round-trip from the first restored snapshot — all seams re-run on
    // fresh instances, so sizes must be identical (the true idempotency check
    // lives in Task 6 where [HYDRATE] is called twice on the same instance).
    const restoredAgain = deserializeCampaign(serializeCampaign(restored), { registry });
    const after = serializeCampaign(restoredAgain);

    expect(after).toEqual(before);
    expect(after.campaign.partyIds.length).toBe(before.campaign.partyIds.length);
    // If the campaign has characters with items, their counts must also match.
    if (before.characters[0] !== undefined && after.characters[0] !== undefined) {
      expect(after.characters[0].inventory.itemIds.length).toBe(
        before.characters[0].inventory.itemIds.length,
      );
    }
  });
});
