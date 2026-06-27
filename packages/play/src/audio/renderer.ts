import type { AudioEngine } from "./synth.js";
import type { Renderer, SoundSpec } from "./contracts.js";

/** Renders the `synth` arm of a SoundSpec through the procedural engine. */
export class SynthRenderer implements Renderer {
  constructor(private readonly engine: AudioEngine) {}
  render(spec: SoundSpec): void {
    if (spec.kind === "synth") this.engine.play(spec.voice);
    // sample specs are deferred (handled by SampleRenderer once built)
  }
}

/** Stub for scored/sample playback — deferred (architecture only). */
export class SampleRenderer implements Renderer {
  render(_spec: SoundSpec): void { /* deferred: scored audio assets + buffer playback */ }
}
