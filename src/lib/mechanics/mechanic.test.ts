import { describe, it, expect } from "vitest";
import type { Mechanic, JsonObject } from "./mechanic.js";

interface DoomState extends JsonObject { doom: number }

const doomClock: Mechanic<DoomState, { rate: number }> = {
  initialState: (_cfg) => ({ doom: 0 }),
  onRoundEnd: (h) => {
    h.state.doom += 1;
    return h.state.doom >= 10 ? [{ kind: "cue", cue: { text: "Doom!" } }] : [];
  },
};

describe("Mechanic typing", () => {
  it("constructs initial state from config and mutates own state", () => {
    const state = doomClock.initialState({ rate: 1 });
    expect(state).toEqual({ doom: 0 });
  });
});
