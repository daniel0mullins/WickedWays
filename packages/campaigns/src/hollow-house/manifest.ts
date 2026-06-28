import type { CampaignManifest } from "@wickedways/play-runtime";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, ALIASES, TITLE, INTRO } from "./index.js";
import { Archetypes } from "./ids.js";
import { hollowHouseAudio } from "./audio.js";
import { hollowHouseThemes } from "./themes.js";

export const hollowHouse: CampaignManifest = {
  slug: "hollow-house",
  title: TITLE,
  blurb: "A nine-room haunted estate. Reach the attic with the journal before the dark takes your mind.",
  intro: INTRO,
  buttonText: "Enter Hollow House",
  builder: hauntedHouseTemplate,
  registry: buildHauntedHouseRegistry,
  aliases: ALIASES,
  playerName: "Heir",
  archetype: Archetypes.Heir,
  audio: hollowHouseAudio,
  surfaces: [{ id: "crt-terminal", themes: hollowHouseThemes }],
};
