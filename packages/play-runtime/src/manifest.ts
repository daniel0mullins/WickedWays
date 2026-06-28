import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignAudio } from "./audio/contracts.js";
import type { Theme } from "./surface.js";

export type AliasMap = Record<string, string[]>;

/**
 * Everything the launcher needs to present and boot one campaign.
 *
 * **Adding a campaign.** Create a folder under `packages/campaigns/src/<slug>/`
 * that exports a `CampaignManifest` as its named export, then register it in
 * `packages/play/src/main.ts` by passing it to `bootLauncher`.
 */
export interface CampaignManifest {
  /** Registry key and `?campaign=` deep-link value. Must be URL-safe and unique. */
  slug: string;
  /** Human-readable campaign name shown in the launcher menu. */
  title: string;
  /** One or two-line description shown in the launcher menu below the title. */
  blurb: string;
  /** Welcome-screen body text shown before the player enters the campaign. */
  intro: string;
  /** Label for the welcome-screen start button. Defaults to `"Enter <title>"`. */
  buttonText?: string;
  /**
   * Factory that returns a fresh `TemplateBuilder`.
   * Called on every boot and restart so each run starts from a clean template.
   */
  builder: () => TemplateBuilder<string, string>;
  /**
   * Factory that returns a fresh `CampaignRegistry`.
   * Called on every boot and restart alongside `builder`.
   */
  registry: () => CampaignRegistry;
  /** Verb/noun aliases used by the parser to resolve player input. */
  aliases: AliasMap;
  /** Display name of the player character (e.g. `"Heir"`). */
  playerName: string;
  /** Archetype id applied to the player character at session start. */
  archetype: string;
  /**
   * Campaign audio wiring — director + soundpacks.
   * Omit to use the flat ambient bed and default chiptune SFX only.
   */
  audio?: CampaignAudio;
  /**
   * `PlaySurface` id this campaign runs on.
   * Defaults to `"crt-terminal"` when omitted.
   */
  surface?: string;
  /**
   * Campaign-supplied themes for the designated surface.
   * `themes[0]` is the active default; the player may switch between them live.
   * Omit to use the surface's own default theme (switcher auto-hides).
   */
  themes?: Theme[];
}
