import { describe, it, expect } from "vitest";
import { DEFAULT_AV_POLICY, type AvPolicy } from "./av-policy";

describe("DEFAULT_AV_POLICY", () => {
  it("enables A/V with video and a 6-participant cap", () => {
    const p: AvPolicy = DEFAULT_AV_POLICY;
    expect(p).toEqual({ enabled: true, video: true, maxParticipants: 6 });
  });
});
