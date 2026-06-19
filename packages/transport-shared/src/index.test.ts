import { describe, it, expect } from "vitest";
import { parseClientMsg, parseServerMsg } from "./index.js";

describe("parseClientMsg", () => {
  it("accepts a well-formed join (token)", () => {
    expect(parseClientMsg({ t: "join", campaignId: "c1", token: "tok", fromSeq: 0 })).toEqual({
      t: "join", campaignId: "c1", token: "tok", fromSeq: 0,
    });
    expect(parseClientMsg({ t: "join", campaignId: "c1", token: 7, fromSeq: 0 })).toBeNull();
  });

  it("accepts an append with an actor + opaque entry; rejects a missing/invalid actor", () => {
    const entry = { seq: 1, baseSeq: 0, command: { kind: "x" }, delta: { changed: [] } };
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "gm" } })).toEqual({
      t: "append", campaignId: "c1", entry, actor: { kind: "gm" },
    });
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "character", actorId: "a" } })).not.toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "join", characterId: "c" } })).not.toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry })).toBeNull(); // missing actor
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "nope" } })).toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "character" } })).toBeNull(); // missing actorId
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
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry: { seq: 1 }, actor: { kind: "gm" } })).toBeNull(); // bad entry
  });
});

describe("parseServerMsg", () => {
  it("accepts joined / appendOk / appendConflict / snapshot(null) / error", () => {
    expect(parseServerMsg({ t: "joined", head: 3 })).toEqual({ t: "joined", head: 3 });
    expect(parseServerMsg({ t: "appendOk", seq: 4 })).toEqual({ t: "appendOk", seq: 4 });
    expect(parseServerMsg({ t: "appendConflict", head: 7 })).toEqual({ t: "appendConflict", head: 7 });
    expect(parseServerMsg({ t: "snapshot", seq: 0, snapshot: null })).toEqual({ t: "snapshot", seq: 0, snapshot: null });
    expect(parseServerMsg({ t: "error", message: "bad" })).toEqual({ t: "error", message: "bad" });
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
