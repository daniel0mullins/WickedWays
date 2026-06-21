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
});
