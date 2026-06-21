import { describe, it, expect, afterEach } from "vitest";
import { SqliteChatStore } from "./sqlite-chat-store.js";
import type { ChatMsg } from "@wickedways/transport-shared";

const m = (id: number, from: string, body: string, to?: string): ChatMsg => ({ id, from, body, ts: id, to });

describe("SqliteChatStore (sqlite-specific)", () => {
  let store: SqliteChatStore | null = null;
  afterEach(() => { store?.close(); store = null; });

  it("stores to_id as NULL for room messages and non-NULL for whispers", async () => {
    store = new SqliteChatStore(":memory:");
    await store.append("c", m(1, "a", "room"));
    await store.append("c", m(2, "a", "secret", "b"));
    // Verify via get: room msg has no `to`, whisper has `to`
    const room = await store.get("c", 1);
    const whisper = await store.get("c", 2);
    expect(room?.to).toBeUndefined();
    expect(whisper?.to).toBe("b");
  });

  it("stores deleted as 0/1 and reads back as boolean", async () => {
    store = new SqliteChatStore(":memory:");
    await store.append("c", m(1, "a", "hi"));
    // Not deleted → deleted property is falsy/undefined
    const live = await store.get("c", 1);
    expect(live?.deleted).toBeFalsy();
    // Update as tombstone
    await store.update("c", { ...m(1, "a", ""), deleted: true });
    const dead = await store.get("c", 1);
    expect(dead?.deleted).toBe(true);
  });

  it("round-trips reactions JSON (non-empty array)", async () => {
    store = new SqliteChatStore(":memory:");
    const reactions = [{ emoji: "👍", by: ["a", "b"] }];
    await store.append("c", { ...m(1, "a", "cool"), reactions });
    const got = await store.get("c", 1);
    expect(got?.reactions).toEqual(reactions);
  });

  it("returns reactions as undefined (not empty array) when empty", async () => {
    store = new SqliteChatStore(":memory:");
    await store.append("c", m(1, "a", "no reactions"));
    const got = await store.get("c", 1);
    // Should match InMemoryChatStore's shape: undefined when no reactions
    expect(got?.reactions).toBeUndefined();
  });

  it("close() does not throw", () => {
    store = new SqliteChatStore(":memory:");
    expect(() => store?.close()).not.toThrow();
    store = null; // already closed
  });

  it("persists editedTs when updating a message", async () => {
    store = new SqliteChatStore(":memory:");
    await store.append("c", m(1, "a", "original"));
    await store.update("c", { ...m(1, "a", "edited"), editedTs: 42 });
    const got = await store.get("c", 1);
    expect(got?.editedTs).toBe(42);
  });

  it("maxId returns 0 for empty campaign, MAX id otherwise", async () => {
    store = new SqliteChatStore(":memory:");
    expect(await store.maxId("nope")).toBe(0);
    await store.append("c", m(3, "a", "first"));
    await store.append("c", m(7, "a", "second"));
    expect(await store.maxId("c")).toBe(7);
  });
});
