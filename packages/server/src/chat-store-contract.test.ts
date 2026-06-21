import { describe, it, expect } from "vitest";
import { InMemoryChatStore } from "./chat-store.js";
import { SqliteChatStore } from "./sqlite-chat-store.js";
import type { ChatStore } from "./chat-store.js";
import type { ChatMsg } from "@wickedways/transport-shared";

const m = (id: number, from: string, body: string, to?: string): ChatMsg => ({ id, from, body, ts: id, to });

const stores: [string, () => ChatStore][] = [
  ["InMemoryChatStore", () => new InMemoryChatStore()],
  ["SqliteChatStore", () => new SqliteChatStore(":memory:")],
];

describe.each(stores)("ChatStore contract: %s", (_name, make) => {
  it("append + visibility: room msgs visible to all, whisper only to from/to", async () => {
    const s = make();
    await s.append("c", m(1, "a", "room"));
    await s.append("c", m(2, "a", "secret", "b"));
    await s.append("c", m(3, "a", "room2"));
    // third party sees only room messages
    expect((await s.recent("c", "z", 10)).map((x) => x.id)).toEqual([1, 3]);
    // recipient sees room + whisper
    expect((await s.recent("c", "b", 10)).map((x) => x.id)).toEqual([1, 2, 3]);
    // sender sees room + whisper
    expect((await s.recent("c", "a", 10)).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("update in-place: body changes, deleted tombstone", async () => {
    const s = make();
    await s.append("c", m(1, "a", "original"));
    await s.update("c", { ...m(1, "a", "edited"), editedTs: 99 });
    const got = await s.get("c", 1);
    expect(got?.body).toBe("edited");
    expect(got?.editedTs).toBe(99);

    // tombstone
    await s.update("c", { ...m(1, "a", ""), deleted: true });
    expect((await s.get("c", 1))?.deleted).toBe(true);
    expect((await s.get("c", 1))?.body).toBe("");
  });

  it("get: returns null for unknown id", async () => {
    const s = make();
    expect(await s.get("c", 999)).toBeNull();
  });

  it("maxId: returns 0 when empty, else the id of the highest-id appended message", async () => {
    const s = make();
    expect(await s.maxId("c")).toBe(0);
    await s.append("c", m(1, "a", "first"));
    expect(await s.maxId("c")).toBe(1);
    await s.append("c", m(5, "a", "hi"));
    expect(await s.maxId("c")).toBe(5);
  });

  it("page: returns msgs older than cursor, ascending, with correct more flag", async () => {
    const s = make();
    for (let i = 1; i <= 5; i++) await s.append("c", m(i, "a", `#${i}`));

    // before=4, limit=2: visible ids < 4 → [1,2,3], take last 2 → [2,3], more=true (id 1 remains)
    const p1 = await s.page("c", "a", 4, 2);
    expect(p1.msgs.map((x) => x.id)).toEqual([2, 3]);
    expect(p1.more).toBe(true);

    // before=4, limit=3: visible ids < 4 → [1,2,3], take all → [1,2,3], more=false
    const p2 = await s.page("c", "a", 4, 3);
    expect(p2.msgs.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(p2.more).toBe(false);

    // exact-limit boundary: before=4, limit=3 → 3 results, more=false (not more when exact match)
    expect(p2.more).toBe(false);
  });

  it("page more=true when there are more results beyond the limit", async () => {
    const s = make();
    for (let i = 1; i <= 6; i++) await s.append("c", m(i, "a", `#${i}`));
    // before=6, limit=2: visible ids < 6 → [1,2,3,4,5], take last 2 → [4,5], more=true
    const p = await s.page("c", "a", 6, 2);
    expect(p.msgs.map((x) => x.id)).toEqual([4, 5]);
    expect(p.more).toBe(true);
  });

  it("page: whisper visibility applies in paging (third party excludes whisper)", async () => {
    const s = make();
    await s.append("c", m(1, "a", "room1"));
    await s.append("c", m(2, "a", "secret", "b"));
    await s.append("c", m(3, "a", "room2"));
    // third party z, before=3, limit=10: visible ids < 3 → [1], (2 is whisper a→b, z excluded)
    const p = await s.page("c", "z", 3, 10);
    expect(p.msgs.map((x) => x.id)).toEqual([1]);
    expect(p.more).toBe(false);
  });

  it("setRead high-water: lower upTo after higher must NOT regress", async () => {
    const s = make();
    await s.setRead("c", "a", 5);
    await s.setRead("c", "a", 3); // lower — must not regress
    const marks = await s.reads("c");
    expect(marks).toContainEqual({ identity: "a", upTo: 5 });
  });

  it("reads returns all marks for the campaign", async () => {
    const s = make();
    await s.setRead("c", "a", 3);
    await s.setRead("c", "b", 7);
    const marks = await s.reads("c");
    expect(marks).toContainEqual({ identity: "a", upTo: 3 });
    expect(marks).toContainEqual({ identity: "b", upTo: 7 });
    expect(marks).toHaveLength(2);
  });

  it("round-trips the full contract: append + visibility + update + paging + reads", async () => {
    const s = make();
    await s.append("c", m(1, "a", "room"));
    await s.append("c", m(2, "a", "secret", "b"));
    await s.append("c", m(3, "a", "room2"));
    expect((await s.recent("c", "z", 10)).map((x) => x.id)).toEqual([1, 3]);
    expect((await s.recent("c", "b", 10)).map((x) => x.id)).toEqual([1, 2, 3]);
    await s.update("c", { ...m(1, "a", ""), deleted: true });
    expect((await s.get("c", 1))?.deleted).toBe(true);
    const page = await s.page("c", "a", 3, 1);
    expect(page.msgs.map((x) => x.id)).toEqual([2]);
    expect(page.more).toBe(true);
    await s.setRead("c", "a", 3);
    expect(await s.reads("c")).toContainEqual({ identity: "a", upTo: 3 });
  });
});
