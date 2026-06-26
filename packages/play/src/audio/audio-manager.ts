import type { PresentationCue } from "wickedways/lib/presentation";
import type { MobAttack } from "../core/session.js";
import { AudioEngine } from "./synth.js";
import { AmbientBed } from "./ambient.js";
import { soundForCue, soundForMobAttack, errorSound } from "./cue-sound.js";
import { sanityToTension } from "./tension.js";

/** Injection seam for tests; production uses the defaults. */
export interface AudioDeps {
  engine?: AudioEngine;
  ambient?: AmbientBed;
}

/**
 * Owns audio enabled-state and routes game events to sound. Construction is
 * cheap and side-effect-free; the AudioContext is created only when the user
 * enables audio (browser autoplay rule). The single master switch governs both
 * the ambient bed and one-shot SFX.
 */
export class AudioManager {
  readonly #engine: AudioEngine;
  readonly #ambient: AmbientBed;
  #enabled = false;
  #baselineSanity = 0; // high-water mark for tension normalization
  #lastSanity = 0;

  constructor(deps: AudioDeps = {}) {
    this.#engine = deps.engine ?? new AudioEngine();
    this.#ambient = deps.ambient ?? new AmbientBed();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Turn all audio on/off. Enabling resumes the context and starts the drone. */
  setEnabled(on: boolean): void {
    if (on) {
      const ok = this.#engine.resume();
      const ctx = this.#engine.context;
      if (ok && ctx !== null) {
        this.#enabled = true;
        this.#ambient.start(ctx);
        this.#ambient.setTension(this.#currentTension());
      }
      // if resume fails, #enabled stays false — SFX and update remain no-ops
    } else {
      if (this.#enabled) {
        this.#enabled = false;
        this.#ambient.stop();
      }
    }
  }

  /** Play the sound for a presentation cue, if any and if enabled. */
  playCue(cue: PresentationCue): void {
    if (!this.#enabled) return;
    const spec = soundForCue(cue);
    if (spec !== null) this.#engine.play(spec);
  }

  /** Play a mob's strike landing. */
  playMobAttack(atk: MobAttack): void {
    if (!this.#enabled) return;
    this.#engine.play(soundForMobAttack(atk));
  }

  /** Play the error buzz for a rejected command. */
  noteError(): void {
    if (!this.#enabled) return;
    this.#engine.play(errorSound());
  }

  /** Feed the current sanity each turn so the ambient drone tracks the arc. */
  update(sanity: number): void {
    this.#lastSanity = sanity;
    if (sanity > this.#baselineSanity) this.#baselineSanity = sanity;
    if (this.#enabled) this.#ambient.setTension(this.#currentTension());
  }

  #currentTension(): number {
    return sanityToTension(this.#lastSanity, this.#baselineSanity);
  }
}
