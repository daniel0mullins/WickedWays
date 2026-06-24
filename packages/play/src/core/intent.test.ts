import { describe, it, expect } from "vitest";
import { isTimeAdvancing, type Intent } from "./intent.js";

describe("isTimeAdvancing", () => {
  it("advances time for world-changing intents", () => {
    for (const k of ["move", "take", "drop", "use", "attack", "unlock", "wait"] as const) {
      expect(isTimeAdvancing({ kind: k } as Intent)).toBe(true);
    }
  });
  it("is free for housekeeping intents", () => {
    for (const k of ["open", "equip", "unequip"] as const) {
      expect(isTimeAdvancing({ kind: k } as Intent)).toBe(false);
    }
  });
});
