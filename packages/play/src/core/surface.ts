import type { GameSession } from "./session.js";
import type { CampaignManifest } from "./manifest.js";
import type { AudioRuntime } from "../audio/audio-runtime.js";

export interface Theme { id: string; label: string }
export interface SurfaceHandle { unmount(): void }

export interface MountArgs {
  app: HTMLElement;
  session: GameSession;
  manifest: CampaignManifest;
  themes: Theme[];
  audio: AudioRuntime;
  onExit(): void;
}

export interface PlaySurface {
  id: string;
  label: string;
  defaultTheme: Theme;
  mount(args: MountArgs): SurfaceHandle;
}
