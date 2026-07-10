/**
 * Pre-begin TWO-PC oracle harness. `OracleSession` seats exactly one PC and
 * `startSession` (orchestration.ts) calls `beginCampaign()`, so neither can
 * produce a pre-begin MULTI-PC genesis — and a pre-begin snapshot is the only
 * valid oracle for the assembler (`started: false`).
 *
 * Mirrors oracle-session.ts:76-98 (the constructor's boot placement), twice, then
 * captures genesis BEFORE `beginCampaign()`:
 *   * `assemble` builds the player-less, not-begun campaign + its room map.
 *   * each PC is constructed, given the deterministic id `player:{name}` (the
 *     caller-assigned id convention from oracle-session.ts:80), joins, optionally
 *     selects an archetype, and is moved into the start room WITHOUT firing
 *     enter-scenes (`fireScenes = false`) — those are `beginCampaign()`'s job.
 *   * the FIRST seat becomes GM.
 *   * genesis is a deep-copy of the serialized campaign, captured BEFORE
 *     `beginCampaign()` so the fired-scene state never leaks in.
 */
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { structuralClone } from "./gen-helpers.ts";
import type { CharacterId } from "wickedways/lib/character/character";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";

export interface TwoPcSeat {
  name: string;
  archetype?: string;
}

/**
 * Seats `seats` PCs into the template's start room and returns the pre-begin
 * genesis snapshot. Any positive count works; Task 8 passes exactly two.
 */
export function twoPcGenesis(
  builder: TemplateBuilder<string, string>,
  seats: TwoPcSeat[],
): CampaignSnapshot {
  const { campaign, rooms } = assemble(builder.description, builder.registry);
  const start = rooms.get(builder.description.startRoom!)!;
  const pcs = seats.map((seat) => {
    const pc = new PlayerCharacter({ campaign, name: seat.name });
    pc.id = `player:${seat.name}` as CharacterId; // deterministic (regen-stable goldens)
    pc.joinCampaign();
    if (seat.archetype !== undefined) pc.selectArchetype(seat.archetype as ArchetypeId);
    // Boot placement mirrors oracle-session.ts:89 — seat WITHOUT firing enter-scenes.
    pc.move(start, /* fireScenes */ false);
    return pc;
  });
  campaign.gm = pcs[0]!; // first seat is GM
  // PRE-begin genesis: deep-copy at capture (Scene/Exit [SERIALIZE] return state
  // by live reference; capturing before any fire keeps it pristine).
  return structuralClone(serializeCampaign(campaign));
}
