import { describe, it, expect } from "vitest";
import { parseClientMsg, parseServerMsg } from "./index.js";

describe("parseClientMsg", () => {
  it("accepts a well-formed join (token)", () => {
    expect(parseClientMsg({ t: "join", campaignId: "c1", token: "tok", fromSeq: 0 })).toEqual({
      t: "join", campaignId: "c1", token: "tok", fromSeq: 0,
    });
    expect(parseClientMsg({ t: "join", campaignId: "c1", token: 7, fromSeq: 0 })).toBeNull();
  });

  it("round-trips a submit message", () => {
    const msg = { t: "submit", campaignId: "c", command: { kind: "nextPlayer" } };
    expect(parseClientMsg(msg)).toEqual(msg);
  });

  it("rejects a submit without a command", () => {
    expect(parseClientMsg({ t: "submit", campaignId: "c" })).toBeNull();
  });

  it("accepts the GM control messages; rejects malformed ones", () => {
    expect(parseClientMsg({ t: "assignSeat", campaignId: "c1", characterId: "ch", identity: "ada" })).not.toBeNull();
    expect(parseClientMsg({ t: "unassignSeat", campaignId: "c1", characterId: "ch" })).not.toBeNull();
    expect(parseClientMsg({ t: "transferGM", campaignId: "c1", identity: "ben" })).not.toBeNull();
    expect(parseClientMsg({ t: "assignSeat", campaignId: "c1", characterId: "ch" })).toBeNull(); // missing identity
  });

  it("rejects unknown discriminants and malformed shapes", () => {
    expect(parseClientMsg({ t: "nope" })).toBeNull();
    expect(parseClientMsg({ t: "join", campaignId: "c1" })).toBeNull(); // missing fields
    expect(parseClientMsg(null)).toBeNull();
    expect(parseClientMsg("join")).toBeNull();
  });
});

describe("parseServerMsg", () => {
  it("accepts joined / snapshot(null) / error", () => {
    expect(parseServerMsg({ t: "joined", head: 3 })).toEqual({ t: "joined", head: 3 });
    expect(parseServerMsg({ t: "snapshot", seq: 0, snapshot: null })).toEqual({ t: "snapshot", seq: 0, snapshot: null });
    expect(parseServerMsg({ t: "error", message: "bad" })).toEqual({ t: "error", message: "bad" });
  });

  it("round-trips a committed message", () => {
    const msg = { t: "committed", seq: 3, delta: { changed: [], created: [], removed: [] } };
    expect(parseServerMsg(msg)).toEqual(msg);
  });

  it("rejects a committed without a delta", () => {
    expect(parseServerMsg({ t: "committed", seq: 3 })).toBeNull();
  });

  it("accepts denied; rejects malformed denied", () => {
    expect(parseServerMsg({ t: "denied", reason: "nope" })).toEqual({ t: "denied", reason: "nope" });
    expect(parseServerMsg({ t: "denied" })).toBeNull();
  });

  it("rejects malformed server messages", () => {
    expect(parseServerMsg({ t: "joined" })).toBeNull();
    expect(parseServerMsg({ t: "snapshot", seq: 1 })).toBeNull(); // missing snapshot key
    expect(parseServerMsg(42)).toBeNull();
  });

  it("accepts presence; rejects malformed presence", () => {
    const p = { t: "presence", campaignId: "c1", seats: [{ characterId: "ch", owner: "ada", online: true }], gm: { identity: "gm", online: false } };
    expect(parseServerMsg(p)).toEqual(p);
    expect(parseServerMsg({ t: "presence", campaignId: "c1", seats: [{ characterId: "ch" }], gm: { identity: "gm", online: true } })).toBeNull();
  });
});
