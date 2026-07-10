import type { SynthVoice } from "./cue-sound.js";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { ViewModel } from "../viewmodel.js";

/**
 * How to produce one sound event. Two render backends exist:
 * - `"synth"` — synthesized via `SynthRenderer` (Web Audio, no assets).
 * - `"sample"` — decoded `AudioBuffer` or asset path played by `SampleRenderer`
 *   (deferred; the arm is present so samples can be added without touching contracts).
 */
export type SoundSpec =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number };

export interface Renderer { render(spec: SoundSpec): void }

/**
 * The closed set of audio event types the runtime knows about.
 * Campaigns may extend the vocabulary with arbitrary strings — the `AudioCue`
 * type uses `BaseAudioCue | (string & {})` to keep autocomplete while accepting extras.
 */
export type BaseAudioCue =
  | "strike" | "death" | "pickup" | "drop" | "move"
  | "light" | "encounter" | "win" | "lose" | "error" | "takeDamage";

/** A discrete sound event produced by the `AudioDirector` from a `PresentationCue`. */
export interface AudioCue { type: BaseAudioCue | (string & {}); entityId?: string; intensity?: number }

/**
 * Campaign-owned audio brain. Translates engine `PresentationCue`s into `AudioCue`s
 * (discrete events) and reads continuous tension off the `ViewModel` DTO (0–1 scalar
 * that drives the ambient bed).
 *
 * `createDirector()` in `CampaignAudio` is a stateful factory — the director closes
 * over the session high-water-mark sanity, mirroring how `makeStoryteller` closes over
 * lore state. A new director is created on each boot and restart.
 *
 * Layer 1 of the 4-layer audio architecture:
 * `AudioDirector → SoundPack → SoundSpec → AudioBackend`
 */
export interface AudioDirector {
  /** Map one `PresentationCue` to zero or more discrete audio events. */
  react(cue: PresentationCue, view: ViewModel): AudioCue[];
  /** Compute continuous tension (0–1) from the current ViewModel for the
   *  ambient bed. DTO-only: directors never see live engine objects
   *  (master-design invariant 4). */
  tension(view: ViewModel): number;
}

/** How this soundpack wants the ambient bed to behave right now. */
export type AmbientDirective = { bedTension: number };

/**
 * Campaign-owned theme for the audio layer — maps `AudioCue`s to `SoundSpec`s and
 * controls the ambient bed. One soundpack per audio theme (chiptune, scored, etc.).
 *
 * The runtime ships `defaultChiptunePack` covering every `BaseAudioCue` as a fallback.
 * Campaigns spread/override it:
 * ```ts
 * { ...defaultChiptunePack, voice: c => myVoice(c) ?? defaultChiptunePack.voice(c) }
 * ```
 *
 * The surface renders a **soundpack switcher** that auto-hides when fewer than two packs
 * are present. Preference is in-memory (not persisted).
 *
 * Layer 2 of the 4-layer audio architecture:
 * `AudioDirector → SoundPack → SoundSpec → AudioBackend`
 */
export interface SoundPack {
  /** Stable identifier (e.g. `"chiptune"`). */
  id: string;
  /** Human-readable label shown in the soundpack switcher (e.g. `"Chiptune"`). */
  label: string;
  /**
   * Map a discrete audio cue to a sound spec, or `null` for silence.
   * Called by `AudioRuntime` on every `playCue` / `playMobAttack` call.
   */
  voice(cue: AudioCue): SoundSpec | null;
  /**
   * Map a continuous tension value (0–1) to an ambient bed directive.
   * Called on every `update(view)` to drive the `AmbientBed`.
   */
  ambient(tension: number): AmbientDirective;
}

/**
 * Campaign-supplied audio configuration handed to the launcher.
 * The launcher calls `createDirector()` once per boot/restart and stores the
 * director inside the `AudioRuntime` for the life of the session.
 *
 * Omit `audio` from `CampaignManifest` entirely to get the flat ambient bed +
 * default chiptune SFX without any campaign-specific audio logic.
 */
export interface CampaignAudio {
  /**
   * Returns a new stateful director instance.
   * Called once per boot and restart — the director may close over session state
   * (e.g. the high-water-mark sanity for tension normalization).
   */
  createDirector(): AudioDirector;
  /**
   * Available soundpacks; `soundpacks[0]` is active by default.
   * The surface renders a switcher when length ≥ 2.
   */
  soundpacks: SoundPack[];
}
