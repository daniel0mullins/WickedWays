import { describe, it, expect } from "vitest";
import { DEFAULT_CHAT_POLICY, type ChatPolicy } from "./chat-policy";

describe("DEFAULT_CHAT_POLICY", () => {
  it("is fully enabled with a 200-message backfill window", () => {
    const p: ChatPolicy = DEFAULT_CHAT_POLICY;
    expect(p).toEqual({
      enabled: true, whisper: true, edit: true,
      reactions: true, readReceipts: true, typing: true, backfillWindow: 200,
    });
  });
});
