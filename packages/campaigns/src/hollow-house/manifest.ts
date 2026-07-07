import type { CampaignManifest } from "@wickedways/play-runtime";
// Import from the LEAF modules, not the `./index.js` barrel. `index.ts`
// re-exports `hollowHouse` from this file (a cycle), and under that cycle the
// barrel's re-exported bindings (`hollowHouseBehaviors`, `ALIASES`, `TITLE`,
// `INTRO`) are still undefined when this manifest object is constructed — which
// silently left `behaviors` empty and broke boot (`Mechanic 'dread' is not
// registered.`) under strict ESM loaders. The two hoisted functions below are
// defined in index.ts and survive the cycle, so they stay barrel-sourced.
import { hauntedHouseTemplate, buildHauntedHouseRegistry, hollowHouseFormations } from "./index.js";
import { hollowHouseBehaviors } from "./scripted.js";
import { ALIASES, TITLE, INTRO } from "./content.js";
import { Archetypes } from "./ids.js";
import { hollowHouseAudio } from "./audio.js";
import { hollowHouseThemes } from "./themes.js";
import { hollowHousePncThemes } from "./pnc-themes.js";

export const hollowHouse: CampaignManifest = {
  slug: "hollow-house",
  title: TITLE,
  blurb: "A nine-room haunted estate. Reach the attic with the journal before the dark takes your mind.",
  intro: INTRO,
  buttonText: "Enter Hollow House",
  builder: hauntedHouseTemplate,
  registry: buildHauntedHouseRegistry,
  behaviors: hollowHouseBehaviors,
  formations: hollowHouseFormations,
  aliases: ALIASES,
  playerName: "Heir",
  archetype: Archetypes.Heir,
  audio: hollowHouseAudio,
  surfaces: [
    { id: "crt-terminal", themes: hollowHouseThemes },
    { id: "point-and-click", themes: hollowHousePncThemes },
  ],
};
