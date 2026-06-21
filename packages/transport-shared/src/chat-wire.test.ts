import { describe, it, expect } from "vitest";
import { parseClientMsg, parseServerMsg, applyReaction } from "./index.js";
import type { ChatReaction } from "./index.js";

describe("chat wire parsing (phase 1)", () => {
  it("parses chatSend (room) and chatSend (whisper)", () => {
    expect(parseClientMsg({ t: "chatSend", campaignId: "c", body: "hi" }))
      .toEqual({ t: "chatSend", campaignId: "c", body: "hi", to: undefined });
    expect(parseClientMsg({ t: "chatSend", campaignId: "c", body: "psst", to: "id2" }))
      .toEqual({ t: "chatSend", campaignId: "c", body: "psst", to: "id2" });
  });

  it("rejects chatSend without a string body", () => {
    expect(parseClientMsg({ t: "chatSend", campaignId: "c" })).toBeNull();
  });

  it("parses a chat server message", () => {
    const msg = { id: 1, from: "id1", body: "hi", ts: 5 };
    expect(parseServerMsg({ t: "chat", msg })).toEqual({ t: "chat", msg });
  });

  it("parses a players roster", () => {
    const players = [{ identity: "id1", displayName: "Dan", online: true }];
    expect(parseServerMsg({ t: "players", campaignId: "c", players }))
      .toEqual({ t: "players", campaignId: "c", players });
  });

  it("parses chatEdit / chatDelete / chatReact (client)", () => {
    expect(parseClientMsg({ t: "chatEdit", campaignId: "c", id: 1, body: "fix" }))
      .toEqual({ t: "chatEdit", campaignId: "c", id: 1, body: "fix" });
    expect(parseClientMsg({ t: "chatDelete", campaignId: "c", id: 1 }))
      .toEqual({ t: "chatDelete", campaignId: "c", id: 1 });
    expect(parseClientMsg({ t: "chatReact", campaignId: "c", id: 1, emoji: "👍", on: true }))
      .toEqual({ t: "chatReact", campaignId: "c", id: 1, emoji: "👍", on: true });
  });

  it("parses chatEdited / chatDeleted / chatReact (server)", () => {
    expect(parseServerMsg({ t: "chatEdited", campaignId: "c", id: 1, body: "fix", editedTs: 9 }))
      .toEqual({ t: "chatEdited", campaignId: "c", id: 1, body: "fix", editedTs: 9 });
    expect(parseServerMsg({ t: "chatDeleted", campaignId: "c", id: 1 }))
      .toEqual({ t: "chatDeleted", campaignId: "c", id: 1 });
    expect(parseServerMsg({ t: "chatReact", campaignId: "c", id: 1, emoji: "👍", identity: "idA", on: true }))
      .toEqual({ t: "chatReact", campaignId: "c", id: 1, emoji: "👍", identity: "idA", on: true });
  });
});

describe("chat wire parsing (phase 3 — read receipts)", () => {
  it("parses chatRead client message", () => {
    expect(parseClientMsg({ t: "chatRead", campaignId: "c", upTo: 5 }))
      .toEqual({ t: "chatRead", campaignId: "c", upTo: 5 });
  });

  it("rejects chatRead without a number upTo", () => {
    expect(parseClientMsg({ t: "chatRead", campaignId: "c" })).toBeNull();
    expect(parseClientMsg({ t: "chatRead", campaignId: "c", upTo: "5" })).toBeNull();
  });

  it("parses chatReads server message with marks", () => {
    const marks = [{ identity: "idA", upTo: 3 }, { identity: "idB", upTo: 5 }];
    expect(parseServerMsg({ t: "chatReads", campaignId: "c", marks }))
      .toEqual({ t: "chatReads", campaignId: "c", marks });
  });

  it("rejects chatReads when a mark is malformed", () => {
    expect(parseServerMsg({ t: "chatReads", campaignId: "c", marks: [{ identity: 99, upTo: 1 }] })).toBeNull();
    expect(parseServerMsg({ t: "chatReads", campaignId: "c", marks: [{ identity: "id", upTo: "bad" }] })).toBeNull();
  });

  it("parses chatReads with empty marks array", () => {
    expect(parseServerMsg({ t: "chatReads", campaignId: "c", marks: [] }))
      .toEqual({ t: "chatReads", campaignId: "c", marks: [] });
  });
});

describe("applyReaction", () => {
  it("toggles a reaction on (adds identity to existing emoji entry)", () => {
    const input: ChatReaction[] = [{ emoji: "👍", by: ["id1"] }];
    const result = applyReaction(input, "👍", "id2", true);
    expect(result).toContainEqual({ emoji: "👍", by: ["id1", "id2"] });
  });

  it("creates a new emoji entry when none exists", () => {
    const result = applyReaction(undefined, "👍", "id1", true);
    expect(result).toEqual([{ emoji: "👍", by: ["id1"] }]);
  });

  it("toggles a reaction off (removes identity from emoji entry)", () => {
    const input: ChatReaction[] = [{ emoji: "👍", by: ["id1", "id2"] }];
    const result = applyReaction(input, "👍", "id1", false);
    expect(result).toContainEqual({ emoji: "👍", by: ["id2"] });
  });

  it("drops emoji entry when by becomes empty", () => {
    const input: ChatReaction[] = [{ emoji: "👍", by: ["id1"] }];
    const result = applyReaction(input, "👍", "id1", false);
    expect(result.find((r) => r.emoji === "👍")).toBeUndefined();
  });

  it("does not mutate the input array or its entries", () => {
    const input: ChatReaction[] = [{ emoji: "👍", by: ["id1"] }];
    const originalBy = input[0]!.by;
    applyReaction(input, "👍", "id2", true);
    expect(input[0]!.by).toBe(originalBy);
    expect(input[0]!.by).toEqual(["id1"]);
  });
});
