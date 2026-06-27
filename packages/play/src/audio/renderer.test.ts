import { describe, it, expect, vi } from "vitest";
import { SynthRenderer, SampleRenderer } from "./renderer.js";
import type { SynthVoice } from "./cue-sound.js";

describe("SynthRenderer", () => {
  it("plays the voice of a synth SoundSpec through the engine", () => {
    const play = vi.fn();
    const r = new SynthRenderer({ play } as never);
    const voice: SynthVoice = { source: "square", freq: 440, duration: 0.1, gain: 0.2, attack: 0.01 };
    r.render({ kind: "synth", voice });
    expect(play).toHaveBeenCalledWith(voice);
  });
  it("ignores sample specs for now (deferred)", () => {
    const play = vi.fn();
    new SynthRenderer({ play } as never).render({ kind: "sample", asset: "x" });
    expect(play).not.toHaveBeenCalled();
  });
});

describe("SampleRenderer", () => {
  it("is a no-op stub (scored audio deferred)", () => {
    expect(() => new SampleRenderer().render({ kind: "sample", asset: "x" })).not.toThrow();
  });
});
