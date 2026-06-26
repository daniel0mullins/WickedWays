import type { SoundSpec } from "./cue-sound.js";

/**
 * Web Audio backend that renders {@link SoundSpec}s as one-shot sounds. The
 * `AudioContext` is created lazily through an injected factory so tests can pass
 * a fake (the node test environment has no Web Audio) and so construction is
 * deferred until a user gesture enables audio.
 */
export class AudioEngine {
  #ctx: AudioContext | null = null;
  readonly #factory: () => AudioContext;

  constructor(factory: () => AudioContext = () => new AudioContext()) {
    this.#factory = factory;
  }

  /** Create/resume the context. Returns false if Web Audio is unavailable. */
  resume(): boolean {
    if (this.#ctx === null) {
      try {
        this.#ctx = this.#factory();
      } catch {
        this.#ctx = null;
        return false;
      }
    }
    void this.#ctx.resume();
    return true;
  }

  get context(): AudioContext | null {
    return this.#ctx;
  }

  /** Render a one-shot sound now. No-op if there is no context. */
  play(spec: SoundSpec): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const t0 = ctx.currentTime;
    const end = t0 + spec.duration;

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(spec.gain, t0 + spec.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    if (spec.source === "noise") {
      const src = ctx.createBufferSource();
      const frames = Math.max(1, Math.floor(ctx.sampleRate * spec.duration));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      // Deterministic pseudo-noise (no Math.random): a cheap LCG over the buffer.
      let seed = 1;
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x40000000) - 1;
      }
      src.buffer = buffer;
      src.connect(gain);
      src.start(t0);
      src.stop(end);
    } else {
      const osc = ctx.createOscillator();
      osc.type = spec.source;
      osc.frequency.setValueAtTime(spec.freq, t0);
      if (spec.endFreq !== undefined && spec.endFreq !== spec.freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.endFreq), end);
      }
      osc.connect(gain);
      osc.start(t0);
      osc.stop(end);
    }
  }

  /** Tear down the context (releases audio hardware). */
  close(): void {
    if (this.#ctx !== null) {
      void this.#ctx.close();
      this.#ctx = null;
    }
  }

  /** Suspend the context to release audio hardware while muted. No-op if none. */
  suspend(): void {
    if (this.#ctx !== null) void this.#ctx.suspend();
  }
}
