/**
 * Shared helpers for serialization round-trip tests.
 * Extracted so Tasks 5, 6, 9 (and others) can reuse the same campaign fixture.
 */
import { Campaign } from "../campaign";
import { PlayerCharacter } from "../character/player-character";
import { Room } from "../room";
import { StatType } from "../character/stats";
import type { ArchetypeId } from "../archetype";
import type { ExitsArg } from "../../test-utils";
import { CampaignRegistry } from "./registry";

function makeStats() {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
  };
}

/**
 * Builds a minimal but fully-wired campaign suitable for serialization tests.
 * Returns the campaign and a fresh {@link CampaignRegistry} (with no custom
 * registrations — suitable for default round-trips).
 */
export function buildSerializableCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const campaign = new Campaign("Crypt", 10, [], { rng: () => 0.5 });
  campaign.registerArchetype({
    id: "delver" as ArchetypeId,
    name: "Delver",
    statModifiers: { [StatType.Health]: 2 },
  });
  const start = new Room("Start", "the entrance", [], {} as ExitsArg);
  const pc = new PlayerCharacter(campaign, "Ada", makeStats());
  pc.joinCampaign();
  campaign.gm = pc;
  pc.selectArchetype("delver" as ArchetypeId);
  pc.move(start);

  const registry = new CampaignRegistry();
  return { campaign, registry };
}
