/**
 * A continuous, sanity-reactive drone. Two detuned sawtooth oscillators feed a
 * fixed dark low-pass filter and a master gain — a deep sub-bass hum. Dread is
 * expressed purely as BEAT RATE: the two oscillators beat at a frequency equal
 * to their detune (Hz), so as sanity falls the partner drifts further from the
 * fundamental and the pulse quickens — a slow calm throb when sane, fast and
 * anxious as sanity drains. Timbre and loudness stay constant (so it never reads
 * as "getting louder"). Designed to run only in the browser; tests inject a fake
 * AudioContext.
 */
export class AmbientBed {
  #ctx: AudioContext | null = null;
  #osc2: OscillatorNode | null = null;
  #filter: BiquadFilterNode | null = null;
  #gain: GainNode | null = null;
  #nodes: AudioScheduledSourceNode[] = [];

  // Tunable voice — dial these by ear on the running dev server.
  static readonly #BASE_HZ = 55;          // A1 fundamental
  static readonly #DETUNE_HZ = 0.5;       // calm beat rate: osc2 sits BASE + DETUNE (~0.5 Hz pulse)
  static readonly #DETUNE_SPREAD_HZ = 5.5; // beat rate at full dread: BASE + DETUNE + SPREAD (~6 Hz throb)
  static readonly #CUTOFF = 120;          // fixed dark sub-bass cutoff (no longer sweeps — was the loudness creep)
  static readonly #LEVEL = 0.3;           // bed gain (lower if it overpowers SFX)
  static readonly #FADE_S = 0.12;         // gain fade-in to avoid a click on enable
  static readonly #GLIDE_S = 0.05;        // per-update beat glide

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
    filter.frequency.setValueAtTime(AmbientBed.#CUTOFF, now); // fixed dark cutoff
    filter.connect(gain);

    const osc1 = ctx.createOscillator();
    osc1.type = "sawtooth";
    osc1.frequency.setValueAtTime(AmbientBed.#BASE_HZ, now);
    osc1.connect(filter);
    osc1.start(now);

    const osc2 = ctx.createOscillator();
    osc2.type = "sawtooth";
    osc2.frequency.setValueAtTime(AmbientBed.#BASE_HZ + AmbientBed.#DETUNE_HZ, now); // slow beat
    osc2.connect(filter);
    osc2.start(now);

    // Fade in from silence so enabling audio doesn't click.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(AmbientBed.#LEVEL, now + AmbientBed.#FADE_S);

    this.#gain = gain;
    this.#filter = filter;
    this.#osc2 = osc2;
    this.#nodes = [osc1, osc2];
  }

  /** Update the drone's unease, `t` in `[0, 1]`. No-op when not running. */
  setTension(t: number): void {
    const ctx = this.#ctx;
    if (ctx === null || this.#osc2 === null) return;
    const clamped = Math.min(1, Math.max(0, t));
    const end = ctx.currentTime + AmbientBed.#GLIDE_S;
    // Dread = beat rate only. Drift the detuned partner further from the
    // fundamental as sanity falls, so the two oscillators beat faster (slow calm
    // pulse → anxious throb). Glided so it doesn't click; loudness/timbre fixed.
    this.#osc2.frequency.linearRampToValueAtTime(
      AmbientBed.#BASE_HZ + AmbientBed.#DETUNE_HZ + clamped * AmbientBed.#DETUNE_SPREAD_HZ,
      end,
    );
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
