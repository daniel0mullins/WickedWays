import { describe, it, expect, afterEach } from "vitest";
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
});
