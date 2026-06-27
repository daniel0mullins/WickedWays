import { describe, it, expect } from "vitest";
import { AmbientBed } from "./ambient.js";
import { makeFakeAudioContext } from "./fake-audio-context.js";

describe("AmbientBed", () => {
  it("starts two oscillators through a filter and reports running", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const bed = new AmbientBed();
    bed.start(ctx);
    expect(bed.running).toBe(true);
    expect(counts.oscillators).toBe(2);
    expect(counts.filters).toBe(1);
  });

  it("is idempotent on repeated start", () => {
    const { ctx, counts } = makeFakeAudioContext();
    const bed = new AmbientBed();
    bed.start(ctx);
    bed.start(ctx);
    expect(counts.oscillators).toBe(2);
  });

  it("accepts setTension without a running bed (no-op) and after start", () => {
    const { ctx } = makeFakeAudioContext();
    const bed = new AmbientBed();
    expect(() => bed.setTension(0.5)).not.toThrow();
    bed.start(ctx);
    expect(() => bed.setTension(1)).not.toThrow();
    bed.stop();
    expect(bed.running).toBe(false);
  });
});
