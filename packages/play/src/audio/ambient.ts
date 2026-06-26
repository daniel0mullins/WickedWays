/**
 * A continuous, sanity-reactive drone. Two detuned low oscillators feed a
 * low-pass filter and a master gain. As tension rises (sanity falls), the second
 * oscillator detunes wider (beating → dissonance), the filter opens brighter, and
 * the gain lifts slightly. Designed to run only in the browser; tests inject a
 * fake AudioContext.
 */
export class AmbientBed {
  #ctx: AudioContext | null = null;
  #osc2: OscillatorNode | null = null;
  #filter: BiquadFilterNode | null = null;
  #gain: GainNode | null = null;
  #nodes: AudioScheduledSourceNode[] = [];

  static readonly #BASE_HZ = 55; // A1
  static readonly #FADE_S = 0.12;   // gain fade in/out to avoid clicks
  static readonly #GLIDE_S = 0.05;  // per-update parameter glide

  get running(): boolean {
    return this.#ctx !== null;
  }

  /** Begin playback. Idempotent — a second call while running is ignored. */
  start(ctx: AudioContext): void {
    if (this.#ctx !== null) return;
    this.#ctx = ctx;
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(300, now); // tension-0 cutoff
    filter.connect(gain);

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(AmbientBed.#BASE_HZ, now);
    osc1.connect(filter);
    osc1.start(now);

    const osc2 = ctx.createOscillator();
    osc2.type = "sawtooth";
    osc2.frequency.setValueAtTime(AmbientBed.#BASE_HZ * 1.01, now); // tension-0 detune
    osc2.connect(filter);
    osc2.start(now);

    // Fade in from silence so enabling audio doesn't click.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.04, now + AmbientBed.#FADE_S);

    this.#gain = gain;
    this.#filter = filter;
    this.#osc2 = osc2;
    this.#nodes = [osc1, osc2];
  }

  /** Update the drone's unease, `t` in `[0, 1]`. No-op when not running. */
  setTension(t: number): void {
    const ctx = this.#ctx;
    if (ctx === null || this.#osc2 === null || this.#filter === null || this.#gain === null) return;
    const clamped = Math.min(1, Math.max(0, t));
    const end = ctx.currentTime + AmbientBed.#GLIDE_S;
    // Glide so per-turn sanity changes don't click.
    this.#osc2.frequency.linearRampToValueAtTime(AmbientBed.#BASE_HZ * (1.01 + clamped * 0.06), end);
    this.#filter.frequency.linearRampToValueAtTime(300 + clamped * 900, end);
    this.#gain.gain.linearRampToValueAtTime(0.04 + clamped * 0.05, end);
  }

  /** Stop and disconnect all nodes. */
  stop(): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const now = ctx.currentTime;
    // Tear down synchronously and fully: AudioManager suspends the context right
    // after this, so a scheduled fade-out would be cut off mid-ramp anyway.
    // Disconnecting here keeps the graph from accumulating detached filter/gain
    // nodes across toggle cycles. (The fade-IN on start still smooths enabling.)
    for (const n of this.#nodes) {
      try { n.stop(now); } catch { /* already stopped */ }
      n.disconnect();
    }
    this.#filter?.disconnect();
    this.#gain?.disconnect();
    this.#nodes = [];
    this.#osc2 = null;
    this.#filter = null;
    this.#gain = null;
    this.#ctx = null;
  }
}
