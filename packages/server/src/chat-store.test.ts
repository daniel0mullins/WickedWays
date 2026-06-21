import { describe, it, expect } from "vitest";
import { InMemoryChatStore } from "./chat-store.js";
import type { ChatMsg } from "@wickedways/transport-shared";

const m = (id: number, from: string, body: string, to?: string): ChatMsg => ({ id, from, body, ts: id, to });

describe("InMemoryChatStore", () => {
  it("appends and returns the recent window ascending", async () => {
    const s = new InMemoryChatStore();
    await s.append("c", m(1, "a", "one"));
    await s.append("c", m(2, "b", "two"));
    expect((await s.recent("c", "a", 10)).map((x) => x.id)).toEqual([1, 2]);
    expect(await s.maxId("c")).toBe(2);
  });

  it("filters whispers by visibility", async () => {
    const s = new InMemoryChatStore();
    await s.append("c", m(1, "a", "room"));
    await s.append("c", m(2, "a", "secret", "b"));
    expect((await s.recent("c", "a", 10)).map((x) => x.id)).toEqual([1, 2]); // sender sees
    expect((await s.recent("c", "b", 10)).map((x) => x.id)).toEqual([1, 2]); // recipient sees
    expect((await s.recent("c", "z", 10)).map((x) => x.id)).toEqual([1]);    // third party: room only
  });

  it("pages older than a cursor with a `more` flag", async () => {
    const s = new InMemoryChatStore();
    for (let i = 1; i <= 5; i++) await s.append("c", m(i, "a", `#${i}`));
    const p = await s.page("c", "a", 4, 2); // ids < 4, limit 2 → [2,3], more=true (id 1 remains)
    expect(p.msgs.map((x) => x.id)).toEqual([2, 3]);
    expect(p.more).toBe(true);
  });

  it("updates a message in place and tracks read marks", async () => {
    const s = new InMemoryChatStore();
    await s.append("c", m(1, "a", "hi"));
    await s.update("c", { ...m(1, "a", "edited"), editedTs: 9 });
    expect((await s.get("c", 1))?.body).toBe("edited");
    await s.setRead("c", "a", 1);
    expect(await s.reads("c")).toEqual([{ identity: "a", upTo: 1 }]);
  });
});
