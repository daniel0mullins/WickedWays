import { describe, it, expect } from "vitest";
import { Chat } from "./chat.js";
import { InMemoryChatStore } from "./chat-store.js";
import { DEFAULT_CHAT_POLICY } from "wickedways/lib/chat-policy";

const clock = () => { let t = 0; return () => ++t; };

describe("Chat — send + backfill", () => {
  it("stamps a monotonic id, from, and ts on send", async () => {
    const chat = await Chat.load("c", DEFAULT_CHAT_POLICY, new InMemoryChatStore(), clock());
    const a = await chat.send("id1", "hello", undefined);
    const b = await chat.send("id2", "hi", undefined);
    expect(a).toMatchObject({ id: 1, from: "id1", body: "hello" });
    expect(b).toMatchObject({ id: 2, from: "id2" });
  });

  it("resumes chatSeq above the store's max id", async () => {
    const store = new InMemoryChatStore();
    await store.append("c", { id: 7, from: "x", body: "old", ts: 0 });
    const chat = await Chat.load("c", DEFAULT_CHAT_POLICY, store, clock());
    expect((await chat.send("id1", "new", undefined) as { id: number }).id).toBe(8);
  });

  it("denies a whisper when policy.whisper is false", async () => {
    const policy = { ...DEFAULT_CHAT_POLICY, whisper: false };
    const chat = await Chat.load("c", policy, new InMemoryChatStore(), clock());
    expect(await chat.send("id1", "psst", "id2")).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("denies empty/blank bodies", async () => {
    const chat = await Chat.load("c", DEFAULT_CHAT_POLICY, new InMemoryChatStore(), clock());
    expect(await chat.send("id1", "   ", undefined)).toMatchObject({ ok: false });
  });

  it("backfills the visible window, newest within backfillWindow", async () => {
    const policy = { ...DEFAULT_CHAT_POLICY, backfillWindow: 2 };
    const chat = await Chat.load("c", policy, new InMemoryChatStore(), clock());
    await chat.send("id1", "1", undefined);
    await chat.send("id1", "2", undefined);
    await chat.send("id1", "3", undefined);
    expect((await chat.backfill("id2")).msgs.map((x) => x.id)).toEqual([2, 3]);
  });
});

describe("Chat — read receipts", () => {
  it("records and returns read marks", async () => {
    const chat = await Chat.load("c", DEFAULT_CHAT_POLICY, new InMemoryChatStore(), clock());
    await chat.send("id1", "hi", undefined);
    const marks = await chat.read("id2", 1) as { identity: string; upTo: number }[];
    expect(marks).toContainEqual({ identity: "id2", upTo: 1 });
  });

  it("denies read receipts when policy.readReceipts is false", async () => {
    const chat = await Chat.load("c", { ...DEFAULT_CHAT_POLICY, readReceipts: false }, new InMemoryChatStore(), clock());
    expect(await chat.read("id2", 1)).toMatchObject({ ok: false });
  });
});

describe("Chat — edit / delete / react", () => {
  const setup = async () => {
    const chat = await Chat.load("c", DEFAULT_CHAT_POLICY, new InMemoryChatStore(), clock());
    const msg = await chat.send("id1", "original", undefined) as { id: number };
    return { chat, id: msg.id };
  };

  it("edits own message and stamps editedTs", async () => {
    const { chat, id } = await setup();
    const r = await chat.edit("id1", id, "edited") as { body: string; editedTs?: number };
    expect(r.body).toBe("edited");
    expect(r.editedTs).toBeGreaterThan(0);
  });

  it("refuses to edit another's message", async () => {
    const { chat, id } = await setup();
    expect(await chat.edit("id2", id, "hax")).toMatchObject({ ok: false });
  });

  it("tombstones on delete", async () => {
    const { chat, id } = await setup();
    const r = await chat.remove("id1", id) as { deleted?: boolean; body: string };
    expect(r.deleted).toBe(true);
    expect(r.body).toBe("");
  });

  it("toggles reactions", async () => {
    const { chat, id } = await setup();
    const on = await chat.react("id2", id, "👍", true) as { reactions?: { emoji: string; by: string[] }[] };
    expect(on.reactions).toContainEqual({ emoji: "👍", by: ["id2"] });
    const off = await chat.react("id2", id, "👍", false) as { reactions?: { emoji: string; by: string[] }[] };
    expect(off.reactions?.find((r) => r.emoji === "👍")).toBeUndefined();
  });

  it("denies edit/react when policy disables them", async () => {
    const chat = await Chat.load("c", { ...DEFAULT_CHAT_POLICY, edit: false, reactions: false }, new InMemoryChatStore(), clock());
    const m = await chat.send("id1", "x", undefined) as { id: number };
    expect(await chat.edit("id1", m.id, "y")).toMatchObject({ ok: false });
    expect(await chat.react("id1", m.id, "👍", true)).toMatchObject({ ok: false });
  });
});
