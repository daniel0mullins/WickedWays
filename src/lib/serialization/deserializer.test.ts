import { describe, it, expect } from "vitest";
import { deserializeCampaign } from "./deserializer";
import { CampaignRegistry } from "./registry";

describe("deserializeCampaign version gate", () => {
  it("rejects an unknown schemaVersion", () => {
    const data = { schemaVersion: 999 } as never;
    expect(() =>
      deserializeCampaign(data, { registry: new CampaignRegistry() }),
    ).toThrow(/schemaVersion/);
  });
});
