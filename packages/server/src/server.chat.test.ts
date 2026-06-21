import { describe, it, expect, afterEach } from "vitest";
import type { PlayerEntry } from "@wickedways/transport-shared";
import { InMemoryChatStore } from "./chat-store.js";
import { makeChatTestServer, connectClient } from "./chat-test-helpers.js";
import type { ServerHandle } from "./server.js";

let handle: ServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("server chat routing", () => {
  it("broadcasts a room message to all joined clients", async () => {
    const result = await makeChatTestServer({ store: new InMemoryChatStore() });
    handle = result.handle;
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "hi all" });
    const got = await b.next((m) => m.t === "chat");
    expect(got).toMatchObject({ t: "chat", msg: { from: "idA", body: "hi all" } });
  });

  it("delivers a whisper only to sender and recipient", async () => {
    const result = await makeChatTestServer({ store: new InMemoryChatStore() });
    handle = result.handle;
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    const c = await connectClient(handle, "tokenC", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "secret", to: "idB" });
    expect(await b.next((m) => m.t === "chat")).toMatchObject({ msg: { body: "secret", to: "idB" } });
    expect(await c.noneWithin(150, (m) => m.t === "chat")).toBe(true);
  });

  it("backfills recent history on join", async () => {
    const store = new InMemoryChatStore();
    const result = await makeChatTestServer({ store });
    handle = result.handle;
    const a = await connectClient(handle, "tokenA", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "before you joined" });
    await a.next((m) => m.t === "chat");
    const late = await connectClient(handle, "tokenB", "campaign1");
    const got = await late.next((m) => m.t === "chat");
    expect(got).toMatchObject({ msg: { body: "before you joined" } });
  });

  it("denies chat when policy.enabled is false", async () => {
    const result = await makeChatTestServer({ store: new InMemoryChatStore(), chatEnabled: false });
    handle = result.handle;
    const a = await connectClient(handle, "tokenA", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "hi" });
    expect(await a.next((m) => m.t === "denied")).toMatchObject({ t: "denied" });
  });

  it("broadcasts an edit to the room", async () => {
    const result = await makeChatTestServer({ store: new InMemoryChatStore() });
    handle = result.handle;
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "typo" });
    const sent = await b.next((m) => m.t === "chat") as { t: "chat"; msg: { id: number } };
    a.send({ t: "chatEdit", campaignId: "campaign1", id: sent.msg.id, body: "fixed" });
    expect(await b.next((m) => m.t === "chatEdited")).toMatchObject({ id: sent.msg.id, body: "fixed" });
  });

  it("broadcasts read marks to the room", async () => {
    ({ handle } = await makeChatTestServer({ store: new InMemoryChatStore() }));
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "hi" });
    await b.next((m) => m.t === "chat");
    b.send({ t: "chatRead", campaignId: "campaign1", upTo: 1 });
    expect(await a.next((m) => m.t === "chatReads")).toMatchObject({ marks: [{ identity: "idB", upTo: 1 }] });
  });

  it("broadcasts read marks to the room on join when readReceipts enabled", async () => {
    const store = new InMemoryChatStore();
    ({ handle } = await makeChatTestServer({ store }));
    const a = await connectClient(handle, "tokenA", "campaign1");
    a.send({ t: "chatSend", campaignId: "campaign1", body: "hello" });
    await a.next((m) => m.t === "chat");
    // a reads up to 1
    a.send({ t: "chatRead", campaignId: "campaign1", upTo: 1 });
    // drain the chatReads broadcast to a (it gets its own broadcast back)
    await a.next((m) => m.t === "chatReads");
    // b joins — should receive chatReads backfill with a's mark
    const b = await connectClient(handle, "tokenB", "campaign1");
    expect(await b.next((m) => m.t === "chatReads")).toMatchObject({ marks: [{ identity: "idA", upTo: 1 }] });
  });

  it("relays typing to the room but not the sender", async () => {
    ({ handle } = await makeChatTestServer({ store: new InMemoryChatStore() }));
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    a.send({ t: "typing", campaignId: "campaign1" });
    expect(await b.next((m) => m.t === "typing")).toMatchObject({ from: "idA" });
    expect(await a.noneWithin(150, (m) => m.t === "typing")).toBe(true);
  });

  it("ignores typing when policy.typing is false (no denial)", async () => {
    ({ handle } = await makeChatTestServer({ store: new InMemoryChatStore(), policy: { typing: false } }));
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    a.send({ t: "typing", campaignId: "campaign1" });
    expect(await b.noneWithin(150, (m) => m.t === "typing")).toBe(true);
    expect(await a.noneWithin(10, (m) => m.t === "denied")).toBe(true);
  });

  it("broadcasts an updated players roster showing a disconnected member offline", async () => {
    // Disconnect the GM (idA / tokenA) — the GM identity is always present in the roster
    // (persistent member), so it should appear as online: false after disconnect.
    // Note: non-seated spectators like idB are intentionally *dropped* from the roster on
    // disconnect (not shown as offline), so they cannot be used to test this behaviour.
    const result = await makeChatTestServer({ store: new InMemoryChatStore() });
    handle = result.handle;
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    // When b joins, the server broadcasts an updated players roster to a — drain it so
    // the next players message a sees is the one triggered by a's disconnect.
    await a.next((m) => m.t === "players");
    // a (the GM) closes the connection — server should broadcast an updated roster to b.
    a.close();
    const roster = await b.next((m) => m.t === "players");
    expect(roster).toMatchObject({ t: "players" });
    const players = (roster as { t: "players"; players: PlayerEntry[] }).players;
    const aEntry = players.find((p) => p.identity === "idA");
    expect(aEntry).toMatchObject({ identity: "idA", online: false });
  });
});
