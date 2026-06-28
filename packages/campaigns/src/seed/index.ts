import { seedTemplate, buildSeedRegistry } from "@wickedways/seed";
import type { CampaignManifest } from "@wickedways/play-runtime";

export const seed: CampaignManifest = {
  slug: "seed",
  title: "Seed Demo",
  blurb: "A minimal demo world used to exercise the engine — a few rooms and a recipe.",
  intro: "A bare proving ground. Look around, take what you find, and step through the door.",
  buttonText: "Enter Demo",
  builder: seedTemplate,
  registry: buildSeedRegistry,
  aliases: {},
  playerName: "Delver",
  archetype: "delver",
};
