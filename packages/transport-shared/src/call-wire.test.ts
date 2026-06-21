import { describe, it, expect } from "vitest";
import { parseClientMsg, parseServerMsg } from "./index.js";

describe("call wire parsing", () => {
  it("parses callJoin / callLeave / avState", () => {
    expect(parseClientMsg({ t: "callJoin", campaignId: "c" })).toEqual({ t: "callJoin", campaignId: "c" });
    expect(parseClientMsg({ t: "callLeave", campaignId: "c" })).toEqual({ t: "callLeave", campaignId: "c" });
    expect(parseClientMsg({ t: "avState", campaignId: "c", muted: true, cameraOn: false }))
      .toEqual({ t: "avState", campaignId: "c", muted: true, cameraOn: false });
  });

  it("parses client signal (opaque data passes through)", () => {
    const m = { t: "signal", campaignId: "c", to: "p2", data: { sdp: "x" } };
    expect(parseClientMsg(m)).toEqual(m);
  });

  it("rejects signal without a string `to`", () => {
    expect(parseClientMsg({ t: "signal", campaignId: "c", data: {} })).toBeNull();
  });

  it("parses callJoined / callPeers / server signal", () => {
    const peers = [{ peerId: "p1", identity: "idA", displayName: "A", muted: false, cameraOn: true }];
    expect(parseServerMsg({ t: "callJoined", campaignId: "c", selfPeerId: "p1", peers, iceServers: [] }))
      .toEqual({ t: "callJoined", campaignId: "c", selfPeerId: "p1", peers, iceServers: [] });
    expect(parseServerMsg({ t: "callPeers", campaignId: "c", peers })).toEqual({ t: "callPeers", campaignId: "c", peers });
    expect(parseServerMsg({ t: "signal", campaignId: "c", from: "p2", data: { ice: 1 } }))
      .toEqual({ t: "signal", campaignId: "c", from: "p2", data: { ice: 1 } });
  });
});
