import type { SynthVoice } from "./cue-sound.js";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { ICampaign } from "wickedways/lib/campaign";
import type { ViewModel } from "../viewmodel.js";

export type SoundSpec =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number };

export interface Renderer { render(spec: SoundSpec): void }

export type BaseAudioCue =
  | "strike" | "death" | "pickup" | "drop" | "move"
  | "light" | "encounter" | "win" | "lose" | "error";

export interface AudioCue { type: BaseAudioCue | (string & {}); entityId?: string; intensity?: number }

export interface AudioDirector {
  react(cue: PresentationCue, view: ViewModel): AudioCue[];
  tension(campaign: ICampaign): number;
}

export type AmbientDirective = { bedTension: number };

export interface SoundPack {
  id: string;
  label: string;
  voice(cue: AudioCue): SoundSpec | null;
  ambient(tension: number): AmbientDirective;
}

export interface CampaignAudio {
  createDirector(): AudioDirector;
  soundpacks: SoundPack[];
}
