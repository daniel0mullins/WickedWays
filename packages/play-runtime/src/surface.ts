import type { GameSession } from "./session.js";
import type { CampaignManifest } from "./manifest.js";
import type { AudioRuntime } from "./audio/audio-runtime.js";

/**
 * Runtime-level base shape for a theme.
 * Each surface defines its own concrete extension (e.g. {@link CrtTheme} for the CRT
 * surface). The base keeps two fields that the launcher and menu use surface-agnostically.
 *
 * **Adding a theme.** Supply a `CrtTheme` (or the target surface's theme type) in
 * `manifest.themes`; `themes[0]` is the default. The surface renders a theme switcher
 * that auto-hides when fewer than two themes are present.
 */
export interface Theme {
  /** Stable identifier used to key the theme in the switcher (e.g. `"default"`). */
  id: string;
  /** Human-readable label shown in the theme switcher (e.g. `"Default"`). */
  label: string;
}

/** Returned by {@link PlaySurface.mount}. Dispose the surface when done. */
export interface SurfaceHandle {
  /** Tear down event listeners, DOM nodes, and audio state owned by this surface mount. */
  unmount(): void;
}

/**
 * Arguments passed to {@link PlaySurface.mount} by the launcher.
 * The launcher owns `session`, `audio`, and `themes`; the surface owns rendering and input.
 */
export interface MountArgs {
  /** The root `HTMLElement` to render into (`#app`). */
  app: HTMLElement;
  /** The live game session — call `execute`, `save`, `restore`, etc. on it. */
  session: GameSession;
  /** The campaign's manifest (title, intro text, etc.). */
  manifest: CampaignManifest;
  /**
   * Non-empty theme list — `manifest.surfaces[i].themes` if present, otherwise `[surface.defaultTheme]`.
   * The surface renders the switcher and applies `themes[0]` on mount.
   */
  themes: Theme[];
  /** Shared audio service — call `playCue`, `update`, `setEnabled`, etc. */
  audio: AudioRuntime;
  /** Callback the surface fires when the player chooses "back to menu". */
  onExit(): void;
  /** Theme id to apply on mount (from `?theme=`); falls back to `themes[0]` if unknown/absent. */
  initialThemeId?: string;
  /** Fired by the surface when the player switches theme, so the launcher can persist `?theme=`. */
  onThemeChange?(id: string): void;
}

/**
 * A pluggable presentation layer that renders a `GameSession` for the player.
 *
 * The runtime owns the session, view models, cues, audio, and save store.
 * The **surface** owns input→intent, the turn loop, DOM rendering, and its own
 * control UI (mute toggle, soundpack switcher, theme switcher, map overlay, etc.).
 *
 * **Adding a surface.** Implement this interface, give it a unique `id`, and pass
 * it in the `surfaces` array to `bootLauncher`. Register it in
 * `packages/play/src/main.ts` and reference it from any campaign's `manifest.surfaces`.
 */
export interface PlaySurface {
  /** Stable identifier matched against `CampaignManifest.surface` (e.g. `"crt-terminal"`). */
  id: string;
  /** Human-readable label for future surface-picker UI. */
  label: string;
  /** One-line description for the surface picker; falls back to `label`. */
  description?: string;
  /** Fallback theme used when a campaign supplies no `manifest.themes`. */
  defaultTheme: Theme;
  /**
   * Mount the surface into `args.app` and return a handle.
   * The launcher calls `unmount()` on the handle when the player exits to the menu.
   */
  mount(args: MountArgs): SurfaceHandle;
}
