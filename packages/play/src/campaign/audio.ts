import { StatType } from "wickedways/lib/character/stats";
import type { ICampaign } from "wickedways/lib/campaign";
import type { AudioDirector, CampaignAudio } from "../audio/contracts.js";
import { defaultDirector, defaultChiptunePack } from "../audio/default-pack.js";
import { sanityToTension } from "../audio/tension.js";

/** Discrete cues use the base mapping; tension is sanity vs. a session high-water-mark. */
export function createHollowHouseDirector(): AudioDirector {
  const base = defaultDirector();
  let baseline = 0; // high-water-mark sanity seen this session
  return {
    react: base.react,
    tension: (c: ICampaign) => {
      const sanity = c.party[0]?.effectiveStat(StatType.Sanity) ?? 0;
      baseline = Math.max(baseline, sanity);
      return sanityToTension(sanity, baseline);
    },
  };
}

export const hollowHouseAudio: CampaignAudio = {
  createDirector: createHollowHouseDirector,
  soundpacks: [defaultChiptunePack],
};
