import { describe, it, expect, afterEach } from "vitest";
import { makeChatTestServer, connectClient } from "./chat-test-helpers.js"; // reuse the merged harness
import type { ServerHandle } from "./server.js";
import type { ServerMsg } from "@wickedways/transport-shared";

function assertCallJoined(m: ServerMsg): asserts m is Extract<ServerMsg, { t: "callJoined" }> {
  if (m.t !== "callJoined") throw new Error(`expected callJoined, got ${m.t}`);
}

function assertSignal(m: ServerMsg): asserts m is Extract<ServerMsg, { t: "signal" }> {
  if (m.t !== "signal") throw new Error(`expected signal, got ${m.t}`);
}

let handle: ServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; });

describe("server A/V signaling", () => {
  it("callJoin acks with selfPeerId, peers, and iceServers", async () => {
    ({ handle } = await makeChatTestServer({}));
    const a = await connectClient(handle, "tokenA", "campaign1");
    a.send({ t: "callJoin", campaignId: "campaign1" });
    const joined = await a.next((m) => m.t === "callJoined");
    assertCallJoined(joined);
    expect(typeof joined.selfPeerId).toBe("string");
    expect(Array.isArray(joined.iceServers)).toBe(true);
  });

  it("relays a signal only to the addressed peer", async () => {
    ({ handle } = await makeChatTestServer({}));
    const a = await connectClient(handle, "tokenA", "campaign1");
    const b = await connectClient(handle, "tokenB", "campaign1");
    a.send({ t: "callJoin", campaignId: "campaign1" });
    const aJoinMsg = await a.next((m) => m.t === "callJoined");
    assertCallJoined(aJoinMsg);
    b.send({ t: "callJoin", campaignId: "campaign1" });
    const bJoinMsg = await b.next((m) => m.t === "callJoined");
    assertCallJoined(bJoinMsg);
    // a signals b
    a.send({ t: "signal", campaignId: "campaign1", to: bJoinMsg.selfPeerId, data: { sdp: "offer" } });
    const got = await b.next((m) => m.t === "signal");
    assertSignal(got);
    expect(got).toMatchObject({ from: aJoinMsg.selfPeerId, data: { sdp: "offer" } });
  });

  it("denies callJoin when A/V is disabled", async () => {
    ({ handle } = await makeChatTestServer({ avEnabled: false }));
    const a = await connectClient(handle, "tokenA", "campaign1");
    a.send({ t: "callJoin", campaignId: "campaign1" });
    expect(await a.next((m) => m.t === "denied")).toMatchObject({ t: "denied" });
  });
});
