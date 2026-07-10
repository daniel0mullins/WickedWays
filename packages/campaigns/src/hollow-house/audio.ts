import type { AudioDirector, CampaignAudio, ViewModel } from "@wickedways/play-runtime";
import { defaultDirector, defaultChiptunePack } from "@wickedways/play-runtime";
import { sanityToTension } from "@wickedways/play-runtime";

/** Discrete cues use the base mapping; tension is sanity vs. a session high-water-mark. */
export function createHollowHouseDirector(): AudioDirector {
  const base = defaultDirector();
  let baseline = 0; // high-water-mark sanity seen this session
  return {
    react: base.react,
    tension: (view: ViewModel) => {
      const sanity = view.status.sanity;
      baseline = Math.max(baseline, sanity);
      return sanityToTension(sanity, baseline);
    },
  };
}

export const hollowHouseAudio: CampaignAudio = {
  createDirector: createHollowHouseDirector,
  soundpacks: [defaultChiptunePack],
};
