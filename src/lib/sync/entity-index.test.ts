import { describe, it, expect } from "vitest";
import { EntityIndex } from "./entity-index";
import { ProceduralViolation } from "../util";
import { buildSerializableCampaign } from "../serialization/roundtrip.test-helpers";

describe("EntityIndex", () => {
  it("resolves live instances by id and throws on a dangling id", () => {
    const { campaign } = buildSerializableCampaign();
    const index = EntityIndex.fromCampaign(campaign);
    const someChar = campaign.party[0]!;
    expect(index.character(someChar.id)).toBe(someChar);
    expect(index.has(someChar.id)).toBe(true);
    expect(() => index.character("nope")).toThrow(ProceduralViolation);
    expect(index.tryCharacter("nope")).toBeUndefined();
  });
});
