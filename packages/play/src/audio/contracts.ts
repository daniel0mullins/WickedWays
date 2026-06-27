import type { SynthVoice } from "./cue-sound.js";

export type SoundSpec =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number };

export interface Renderer { render(spec: SoundSpec): void }
