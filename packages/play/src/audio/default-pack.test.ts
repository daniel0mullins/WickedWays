import { describe, it, expect } from "vitest";
import { defaultChiptunePack, defaultDirector } from "./default-pack.js";
import type { BaseAudioCue } from "./contracts.js";

const BASE: BaseAudioCue[] = ["strike","death","pickup","drop","move","light","encounter","win","lose","error"];

describe("defaultChiptunePack", () => {
  it("returns a synth SoundSpec for every base cue", () => {
    for (const type of BASE) {
      const spec = defaultChiptunePack.voice({ type });
      expect(spec, type).not.toBeNull();
      expect(spec!.kind).toBe("synth");
    }
  });
  it("maps tension straight through to bed tension", () => {
    expect(defaultChiptunePack.ambient(0.7)).toEqual({ bedTension: 0.7 });
  });
});

describe("defaultDirector", () => {
  it("translates an action attack cue into a strike AudioCue and reports zero tension", () => {
    const d = defaultDirector();
    const cues = d.react({ kind: "action", action: "attack", actor: { id: "m", name: "Wraith" } }, {} as never);
    expect(cues.some((c) => c.type === "strike")).toBe(true);
    expect(d.tension({} as never)).toBe(0);
  });
});
