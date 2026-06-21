import { describe, it, expect } from "vitest";
import { Call } from "./call.js";
import { DEFAULT_AV_POLICY } from "wickedways/lib/av-policy";

const name = (id: string) => id.toUpperCase();

describe("Call", () => {
  it("join adds a peer and returns the roster", () => {
    const call = new Call(DEFAULT_AV_POLICY, name);
    const r = call.join("p1", "idA") as { peerId: string; displayName: string; muted: boolean; cameraOn: boolean }[];
    expect(r).toEqual([{ peerId: "p1", identity: "idA", displayName: "IDA", muted: false, cameraOn: false }]);
    expect(call.has("p1")).toBe(true);
  });

  it("denies join when A/V is disabled", () => {
    const call = new Call({ ...DEFAULT_AV_POLICY, enabled: false }, name);
    expect(call.join("p1", "idA")).toMatchObject({ ok: false });
  });

  it("denies join past maxParticipants", () => {
    const call = new Call({ ...DEFAULT_AV_POLICY, maxParticipants: 1 }, name);
    call.join("p1", "idA");
    expect(call.join("p2", "idB")).toMatchObject({ ok: false });
  });

  it("setState toggles mute and denies cameraOn when video disabled", () => {
    const call = new Call({ ...DEFAULT_AV_POLICY, video: false }, name);
    call.join("p1", "idA");
    expect((call.setState("p1", true, false) as { peerId: string; muted: boolean }[])[0]).toMatchObject({ muted: true });
    expect(call.setState("p1", false, true)).toMatchObject({ ok: false });
  });

  it("leave removes a member", () => {
    const call = new Call(DEFAULT_AV_POLICY, name);
    call.join("p1", "idA");
    expect(call.leave("p1")).toBe(true);
    expect(call.has("p1")).toBe(false);
  });
});
