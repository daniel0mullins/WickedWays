// src/lib/exit.test.ts
import { describe, it, expect } from "vitest";
import { Exit, SET_ENDPOINTS, SET_EXIT_STATE } from "./exit";
import type { IRoom } from "./room";
import type { ICharacter } from "./character/character";

const room = (name: string): IRoom => ({ name } as unknown as IRoom);
const charWithKey = (code: string | null): ICharacter =>
  ({ inventory: { keys: code ? [{ keyCode: code }] : [] } } as unknown as ICharacter);

describe("Exit", () => {
  it("otherSide returns the far endpoint, both ways", () => {
    const a = room("A"), b = room("B");
    const e = new Exit({ preconditions: [] });
    e[SET_ENDPOINTS](a, b);
    expect(e.otherSide(a)).toBe(b);
    expect(e.otherSide(b)).toBe(a);
  });

  it("canPass is true with no preconditions and pure (no side effects)", () => {
    const e = new Exit({ preconditions: [] });
    expect(e.canPass(charWithKey(null))).toBe(true);
  });

  it("a keyed precondition gates on the character's keys", () => {
    const e = new Exit<{ unlocked: boolean }>({
      initialState: { unlocked: false },
      preconditions: [(c, s) => s.unlocked || c.inventory.keys.some((k) => k.keyCode === "iron")],
    });
    expect(e.canPass(charWithKey(null))).toBe(false);
    expect(e.canPass(charWithKey("iron"))).toBe(true);
  });

  it("runScript can flip persisted state so the door later opens for anyone", () => {
    const e = new Exit<{ unlocked: boolean }>({
      initialState: { unlocked: false },
      preconditions: [(c, s) => s.unlocked || c.inventory.keys.some((k) => k.keyCode === "iron")],
      script: (_c, s) => { s.unlocked = true; return "The iron key turns."; },
    });
    expect(e.canPass(charWithKey(null))).toBe(false);
    const line = e.runScript(charWithKey("iron"));
    expect(line).toBe("The iron key turns.");
    expect(e.state.unlocked).toBe(true);
    expect(e.canPass(charWithKey(null))).toBe(true); // now open for the keyless
  });

  it("state is only writable through the SET_EXIT_STATE seam", () => {
    const e = new Exit<{ unlocked: boolean }>({ initialState: { unlocked: false }, preconditions: [] });
    expect(() => {
      // @ts-expect-error — no public setter
      e.state = { unlocked: true };
    }).toThrow();
    e[SET_EXIT_STATE]((s) => { s.unlocked = true; });
    expect(e.state.unlocked).toBe(true);
  });
});
