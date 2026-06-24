/**
 * Pass-1 factory for character hydration.
 *
 * This lives in its own module (not in character.ts) to avoid a circular import:
 *   character.ts → player-character.ts / mob.ts → combatant.ts → character.ts
 *
 * The deserializer calls `constructBareCharacter` first (pass 1), then
 * `character[HYDRATE](snap, ctx)` (pass 2) once items/rooms are indexed.
 */

import type { CharacterSnapshot } from "../serialization/types";
import type { ICampaign } from "../campaign";
import type { CampaignRegistry } from "../serialization/registry";
import { Character } from "./character";
import type { CharacterId } from "./character";
import { PlayerCharacter } from "./player-character";
import { NonPlayerCharacter } from "./non-player-character";
import { Mob } from "./mob";

/**
 * Constructs the right subclass from a snapshot with placeholder collections.
 * The real inventory, equipment, history, afflictions, and stats are restored in
 * the subsequent `[HYDRATE]` call; only `id`, `name`, and mob-specific options
 * are seeded here so the instance is fully constructed before wiring. (A player
 * character takes no stats — it starts at the baseline and `[HYDRATE]` overwrites
 * it; a mob still seeds stats since its values are authored, not archetype-based.)
 *
 * @param data - The character snapshot.
 * @param campaign - The campaign this character belongs to.
 * @param registry - The behavior registry; an NPC's dialogue re-binds from it.
 * @returns A freshly constructed `PlayerCharacter`, `Mob`, or `NonPlayerCharacter`, with `id` restored.
 */
export function constructBareCharacter(
  data: CharacterSnapshot,
  campaign: ICampaign,
  registry: CampaignRegistry,
): Character {
  if (data.kind === "mob") {
    // NOTE: baseEscapeChance, materialDrops, and lightAverse are seeded HERE via
    // the Mob constructor options, not in hydrateExtra — the two must stay in sync.
    const mob = new Mob({ campaign, name: data.name, stats: { ...data.stats }, inventorySlots: 0, actionsPerRound: data.actionsPerRound, drops: [], baseEscapeChance: data.baseEscapeChance, materialDrops: data.materialDrops, lightAverse: data.lightAverse });
    mob.id = data.id as CharacterId;
    return mob;
  }
  if (data.kind === "npc") {
    // Dialogue (with its precondition closures) re-binds from the registry by key.
    const behavior = registry.npc(data.npcBehaviorKey!);
    const npc = new NonPlayerCharacter({
      campaign,
      name: data.name,
      stats: { ...data.stats },
      initialDialogue: behavior.initialDialogue,
      dialogueBlocks: behavior.dialogue,
      behaviorKey: data.npcBehaviorKey,
    });
    npc.id = data.id as CharacterId;
    return npc;
  }
  const pc = new PlayerCharacter({ campaign, name: data.name });
  pc.id = data.id as CharacterId;
  return pc;
}
