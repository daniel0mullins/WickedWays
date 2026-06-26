import { describe, it, expect } from "vitest";
import { AudioEngine } from "./synth.js";
import { makeFakeAudioContext } from "./fake-audio-context.js";

describe("AudioEngine", () => {
  it("stays inert when the context factory throws", () => {
    const engine = new AudioEngine(() => { throw new Error("no AudioContext"); });
    expect(engine.resume()).toBe(false);
    expect(engine.context).toBeNull();
    expect(() => engine.play({ source: "square", freq: 100, duration: 0.1, gain: 0.1, attack: 0.001 })).not.toThrow();
  });

  it("creates a context on resume and builds an oscillator on play", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const engine = new AudioEngine(() => ctx);
    expect(engine.resume()).toBe(true);
    engine.play({ source: "square", freq: 200, endFreq: 100, duration: 0.12, gain: 0.18, attack: 0.001 });
    expect(counts.oscillators).toBe(1);
    expect(counts.gains).toBe(1);
  });

  it("builds a buffer source for noise specs", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const engine = new AudioEngine(() => ctx);
    engine.resume();
    engine.play({ source: "noise", freq: 0, duration: 0.2, gain: 0.06, attack: 0.04 });
    expect(counts.buffers).toBe(1);
    expect(counts.oscillators).toBe(0);
  });
});
