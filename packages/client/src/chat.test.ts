import { describe, it, expect } from "vitest";
import { ChatClient } from "./chat.js";

describe("ChatClient", () => {
  it("accumulates chat messages and roster from server msgs", () => {
    const c = new ChatClient();
    c.onServerMsg({ t: "chat", msg: { id: 1, from: "idA", body: "hi", ts: 1 } });
    c.onServerMsg({ t: "players", campaignId: "c", players: [{ identity: "idA", displayName: "Dan", online: true }] });
    expect(c.messages.map((m) => m.body)).toEqual(["hi"]);
    expect(c.players[0]?.displayName).toBe("Dan");
  });

  it("builds a room send and a whisper send", () => {
    const c = new ChatClient();
    expect(c.send("hello")).toEqual({ t: "chatSend", campaignId: c.campaignId, body: "hello", to: undefined });
    expect(c.send("psst", "idB")).toEqual({ t: "chatSend", campaignId: c.campaignId, body: "psst", to: "idB" });
  });

  it("orders backfilled history before live messages by id", () => {
    const c = new ChatClient();
    c.onServerMsg({ t: "chat", msg: { id: 2, from: "x", body: "live", ts: 2 } });
    c.onServerMsg({ t: "chatHistory", campaignId: c.campaignId, msgs: [{ id: 1, from: "x", body: "old", ts: 1 }], more: false });
    expect(c.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("tracks read marks from chatReads server message", () => {
    const c = new ChatClient();
    c.onServerMsg({ t: "chatReads", campaignId: c.campaignId, marks: [{ identity: "idA", upTo: 3 }, { identity: "idB", upTo: 5 }] });
    expect(c.reads.get("idA")).toBe(3);
    expect(c.reads.get("idB")).toBe(5);
  });

  it("replaces read marks on a subsequent chatReads message", () => {
    const c = new ChatClient();
    c.onServerMsg({ t: "chatReads", campaignId: c.campaignId, marks: [{ identity: "idA", upTo: 3 }] });
    c.onServerMsg({ t: "chatReads", campaignId: c.campaignId, marks: [{ identity: "idA", upTo: 7 }, { identity: "idB", upTo: 2 }] });
    expect(c.reads.get("idA")).toBe(7);
    expect(c.reads.get("idB")).toBe(2);
  });

  it("typingIdentities returns identities seen within the window", () => {
    const c = new ChatClient();
    const before = Date.now();
    c.onServerMsg({ t: "typing", campaignId: c.campaignId, from: "idA" });
    c.onServerMsg({ t: "typing", campaignId: c.campaignId, from: "idB" });
    const after = Date.now();
    // Both identities should appear when queried with a generous now
    expect(c.typingIdentities(after + 1000)).toContain("idA");
    expect(c.typingIdentities(after + 1000)).toContain("idB");
    // When now is far in the future (well past the window), they should disappear
    expect(c.typingIdentities(before + 10_000, 4000)).not.toContain("idA");
    expect(c.typingIdentities(before + 10_000, 4000)).not.toContain("idB");
  });

  it("applies edit, delete, and reaction updates", () => {
    const c = new ChatClient();
    c.onServerMsg({ t: "chat", msg: { id: 1, from: "x", body: "hi", ts: 1 } });
    c.onServerMsg({ t: "chatEdited", campaignId: c.campaignId, id: 1, body: "yo", editedTs: 2 });
    expect(c.messages[0]?.body).toBe("yo");
    c.onServerMsg({ t: "chatReact", campaignId: c.campaignId, id: 1, emoji: "👍", identity: "y", on: true });
    expect(c.messages[0]?.reactions).toContainEqual({ emoji: "👍", by: ["y"] });
    c.onServerMsg({ t: "chatDeleted", campaignId: c.campaignId, id: 1 });
    expect(c.messages[0]?.deleted).toBe(true);
  });
});
