import type { PresentationCue } from "wickedways/lib/presentation";
import type { MobAttack } from "../session.js";

/** Oscillator waveforms a SoundSpec can request. */
export type Waveform = "sine" | "square" | "sawtooth" | "triangle";

/**
 * A declarative, backend-agnostic description of a one-shot procedural sound.
 * The Web Audio backend ({@link AudioEngine}) renders it; this module never
 * touches Web Audio, so the mapping stays pure and unit-testable under the
 * node test environment.
 */
export interface SynthVoice {
  /** Oscillator waveform, or "noise" for a white-noise burst. */
  source: Waveform | "noise";
  /** Start frequency in Hz (ignored when `source` is "noise"). */
  freq: number;
  /** Optional end frequency for a pitch glide; defaults to `freq`. */
  endFreq?: number;
  /** Total duration in seconds. */
  duration: number;
  /** Peak gain, 0..1. */
  gain: number;
  /** Attack time in seconds (linear ramp to peak). */
  attack: number;
}

/**
 * Deterministic pitch multiplier in ~`[0.97, 1.03]` derived from an id string,
 * so repeated events feel alive without using `Math.random` (repo convention).
 */
export function detuneFactor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const frac = (Math.abs(h) % 1000) / 1000; // 0..1
  return 0.97 + frac * 0.06;
}

/** Maps a presentation cue to a sound, or `null` when the event is silent. */
export function soundForCue(cue: PresentationCue): SynthVoice | null {
  switch (cue.kind) {
    case "action":
      switch (cue.action) {
        case "attack": {
          const f = 190 * detuneFactor(cue.actor.id);
          return { source: "square", freq: f, endFreq: f * 0.5, duration: 0.12, gain: 0.18, attack: 0.001 };
        }
        case "takeDamage":
          return { source: "noise", freq: 0, duration: 0.14, gain: 0.16, attack: 0.001 };
        case "pickUp":
          return { source: "triangle", freq: 660, endFreq: 990, duration: 0.09, gain: 0.12, attack: 0.005 };
        case "drop":
          return { source: "triangle", freq: 520, endFreq: 330, duration: 0.09, gain: 0.12, attack: 0.005 };
        case "move":
          return { source: "noise", freq: 0, duration: 0.22, gain: 0.06, attack: 0.04 };
        case "escape":
        case "fumble":
        case "mechanicAction":
          return null;
      }
      return null;
    case "encounter":
      return { source: "sawtooth", freq: 110, endFreq: 330, duration: 0.5, gain: 0.14, attack: 0.08 };
    case "visibility":
      return { source: "square", freq: 1200, duration: 0.04, gain: 0.08, attack: 0.001 };
    case "resolution":
      // CampaignOutcome: "ongoing" | "won" | "lost" | "timed-out" | "ended".
      // "won" rises triumphantly; every other terminal outcome falls.
      if (cue.outcome === "won") return { source: "triangle", freq: 523, endFreq: 784, duration: 0.6, gain: 0.16, attack: 0.02 };
      if (cue.outcome === "lost") return { source: "sine", freq: 220, endFreq: 55, duration: 0.8, gain: 0.16, attack: 0.02 };
      return null;
    case "mechanic":
      return null;
    case "status":
      return null;
  }
}

/** A mob's strike landing on the player. */
export function soundForMobAttack(_atk: MobAttack): SynthVoice {
  return { source: "square", freq: 150, endFreq: 80, duration: 0.13, gain: 0.16, attack: 0.001 };
}

/** A short low buzz for a rejected command or illegal action. */
export function errorSound(): SynthVoice {
  return { source: "square", freq: 90, duration: 0.12, gain: 0.1, attack: 0.001 };
}
