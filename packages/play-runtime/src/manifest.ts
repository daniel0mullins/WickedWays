import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignAudio } from "./audio/contracts.js";
import type { Theme } from "./surface.js";
import type { BehaviorScript } from "../../../generated/bindings/BehaviorScript.ts";

export type AliasMap = Record<string, string[]>;

/**
 * A surface this campaign can run on, with that surface's themes (its own Theme shape).
 */
export interface SurfaceChoice {
  /** `PlaySurface` id, e.g. `"crt-terminal"` or `"point-and-click"`. */
  id: string;
  /** Themes for THIS surface; `themes[0]` is the default. Omit → the surface's own default. */
  themes?: readonly Theme[];
}

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
  /**
   * Factory that returns the campaign's scripted behaviors (mechanics, scripted
   * items, doors, victory conditions), keyed by mechanic/item/exit/victory key.
   * Threaded into the Rust Catalog so `Authority::new`→`validate_mechanics` can
   * resolve every registered key. Omit for behavior-less campaigns (defaults to `{}`).
   */
  behaviors?: () => Record<string, BehaviorScript>;
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
   * Surfaces this campaign offers; `surfaces[0]` is the default.
   * Omit → one default `"crt-terminal"`.
   */
  surfaces?: readonly SurfaceChoice[];
}
