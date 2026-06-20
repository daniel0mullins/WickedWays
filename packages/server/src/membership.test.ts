import { describe, it, expect } from "vitest";
import { Membership } from "./membership.js";
import type { MembershipState } from "./store.js";

describe("Membership", () => {
  it("starts with only the GM identity and no seats", () => {
    const m = new Membership("gm");
    expect(m.gmIdentity).toBe("gm");
    expect(m.seats()).toEqual([]);
    expect(m.ownerOf("c1")).toBeNull();
  });

  it("mayAct: character requires owning the seat", () => {
    const m = new Membership("gm");
    m.claim("c1", "ada");
    expect(m.mayAct("ada", { kind: "character", actorId: "c1" })).toBe(true);
    expect(m.mayAct("ben", { kind: "character", actorId: "c1" })).toBe(false);
    expect(m.mayAct("ada", { kind: "character", actorId: "cX" })).toBe(false); // unowned seat
  });

  it("mayAct: gm requires being the GM identity", () => {
    const m = new Membership("gm");
    expect(m.mayAct("gm", { kind: "gm" })).toBe(true);
    expect(m.mayAct("ada", { kind: "gm" })).toBe(false);
  });

  it("mayAct: join is allowed only for an unowned seat (no hijack)", () => {
    const m = new Membership("gm");
    expect(m.mayAct("ada", { kind: "join", characterId: "c1" })).toBe(true); // unowned -> may claim
    m.claim("c1", "ada");
    expect(m.mayAct("ben", { kind: "join", characterId: "c1" })).toBe(false); // already owned -> no hijack
  });

  it("claim / assign / unassign / transferGM mutate ownership", () => {
    const m = new Membership("gm");
    m.claim("c1", "ada");
    expect(m.ownerOf("c1")).toBe("ada");
    m.assign("c1", "ben"); // GM override reassigns
    expect(m.ownerOf("c1")).toBe("ben");
    m.unassign("c1");
    expect(m.ownerOf("c1")).toBeNull();
    m.transferGM("ada");
    expect(m.gmIdentity).toBe("ada");
  });

  it("seats() lists current ownerships", () => {
    const m = new Membership("gm");
    m.claim("c1", "ada");
    m.claim("c2", "ben");
    expect(new Map(m.seats())).toEqual(new Map([["c1", "ada"], ["c2", "ben"]]));
  });

  it("round-trips through toState / fromState", () => {
    const m = new Membership("gm-1");
    m.claim("ada", "ident-ada");
    m.assign("ben", "ident-ben");
    const state: MembershipState = m.toState();
    expect(state).toEqual({ gmIdentity: "gm-1", seats: [["ada", "ident-ada"], ["ben", "ident-ben"]] });

    const restored = Membership.fromState(state);
    expect(restored.gmIdentity).toBe("gm-1");
    expect(restored.ownerOf("ada")).toBe("ident-ada");
    expect(restored.ownerOf("ben")).toBe("ident-ben");
    expect(restored.toState()).toEqual(state);
  });
});
