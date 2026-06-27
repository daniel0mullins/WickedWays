import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";

export type AliasMap = Record<string, string[]>;

/** Everything the launcher needs to present and boot one campaign. */
export interface CampaignManifest {
  slug: string;
  title: string;
  blurb: string;
  intro: string;
  buttonText?: string;
  /** Fresh builder per boot/restart. */
  builder: () => TemplateBuilder<string, string>;
  /** Fresh registry per boot. */
  registry: () => CampaignRegistry;
  aliases: AliasMap;
  playerName: string;
  archetype: string;
  // surface, themes, and audio are added in later tasks.
}
