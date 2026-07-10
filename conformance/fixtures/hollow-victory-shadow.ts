/**
 * TS shadows of the Hollow House victory conditions — MUST match
 * packages/campaigns/src/hollow-house/index.ts:23-28 exactly (they are inline
 * lambdas there, hence this re-declaration; shared by all scripted-victory
 * generators so the oracle cannot drift between fixtures).
 */
import type { ICampaign } from "wickedways/lib/campaign";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import { Rooms, Items } from "../../packages/campaigns/src/hollow-house/ids.ts";

export const reachedAtticWithJournal = (c: ICampaign): boolean => {
  const pc = c.party[0];
  return pc?.currentRoom?.name === Rooms.Attic &&
    pc.inventory.items.some((i) => i.behaviorKey === Items.Journal);
};
export const sanityZero = (c: ICampaign): boolean =>
  c.party.some((p) => p.effectiveStat(StatType.Sanity) <= 0);
export const partyDown = (c: ICampaign): boolean =>
  c.party.length > 0 && c.party.every((p) => p.status.includes(Status.KO));
