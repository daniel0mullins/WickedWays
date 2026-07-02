import { assemble } from "./assembler";
import { PlayerCharacter } from "../character/player-character";
import { generateId, ProceduralViolation } from "../util";
import type { CampaignId } from "../campaign";
import type { CharacterId } from "../character/character";
import type { Campaign } from "../campaign";
import type { ArchetypeId } from "../archetype";
import type { CampaignSnapshot } from "../serialization/types";
import type { TemplateBuilder } from "./template-builder";

/**
 * A player specification for {@link startSession}.
 */
export interface SessionPlayer {
  /** Display name for this player character. */
  name: string;
  /**
   * Archetype id string (cast to {@link ArchetypeId} at the boundary). Optional:
   * when omitted, `beginCampaign` auto-selects the sole registered archetype if
   * exactly one exists. A player character starts at the baseline stats; its
   * archetype is the only thing that adjusts them.
   */
  archetype?: string;
}

/**
 * Clones a template snapshot and assigns a fresh campaign-core id, leaving all
 * entity ids unchanged. Each call produces an isolated instance genesis.
 *
 * @remarks Re-serializing a deserialized/hydrated player-less campaign requires
 *   passing `rootRooms` to {@link serializeCampaign} (the BFS is still
 *   party-rooted, so an empty party produces an empty snapshot). Prefer using
 *   the template snapshot directly — as `instantiate` does via `structuredClone`
 *   — rather than hydrating and re-serializing.
 *
 * @param template - The source template snapshot (not mutated).
 * @returns A new snapshot with a fresh campaign id and the same world.
 */
export function instantiate(template: CampaignSnapshot): CampaignSnapshot {
  const clone = structuredClone(template);
  clone.campaign.id = generateId<CampaignId>();
  return clone;
}

/**
 * Assembles the template, joins players, selects their archetypes, sets the GM,
 * and begins the campaign — returning a fully started {@link Campaign}.
 *
 * @param builder - The template builder (provides `.description` and `.registry`).
 * @param opts - Session options: the list of players, the GM index, and an optional start room name.
 * @returns The started campaign.
 */
export function startSession(
  builder: TemplateBuilder<string, string>,
  opts: { players: SessionPlayer[]; gm: number; startRoom?: string },
): Campaign {
  const { players, gm, startRoom } = opts;
  const { campaign, rooms } = assemble(builder.description, builder.registry);

  const startRoomName = startRoom ?? builder.description.startRoom;
  const startRoomInstance = startRoomName !== undefined ? rooms.get(startRoomName) : undefined;
  if (startRoomInstance === undefined) {
    throw new ProceduralViolation(
      `startSession: start room ${
        startRoomName === undefined
          ? "(none — author a .startRoom() or pass opts.startRoom)"
          : `'${startRoomName}'`
      } not found`,
    );
  }

  const pcs: PlayerCharacter[] = [];
  for (const p of players) {
    const pc = new PlayerCharacter({ campaign, name: p.name });
    pc.id = `player:${p.name}` as CharacterId;
    pc.joinCampaign();
    // When an archetype is omitted, beginCampaign auto-selects the sole
    // registered archetype (if exactly one exists).
    if (p.archetype !== undefined) {
      pc.selectArchetype(p.archetype as ArchetypeId);
    }
    pc.move(startRoomInstance);
    pcs.push(pc);
  }

  campaign.gm = pcs[gm];
  campaign.beginCampaign();

  return campaign;
}
