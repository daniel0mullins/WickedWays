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
import { Character } from "./character";
import type { CharacterId } from "./character";
import { PlayerCharacter } from "./player-character";
import { Mob } from "./mob";

/**
 * Constructs the right subclass from a snapshot with placeholder collections.
 * The real inventory, equipment, history, and afflictions are restored in the
 * subsequent `[HYDRATE]` call; only `id`, `name`, `stats`, and mob-specific
 * options are seeded here so the instance is fully constructed before wiring.
 *
 * @param data - The character snapshot.
 * @param campaign - The campaign this character belongs to.
 * @returns A freshly constructed `PlayerCharacter` or `Mob`, with `id` restored.
 */
export function constructBareCharacter(data: CharacterSnapshot, campaign: ICampaign): Character {
  if (data.kind === "mob") {
    const mob = new Mob(campaign, data.name, { ...data.stats }, 0, data.actionsPerRound, [], {
      baseEscapeChance: data.baseEscapeChance,
      materialDrops: data.materialDrops,
      lightAverse: data.lightAverse,
    });
    mob.id = data.id as CharacterId;
    return mob;
  }
  const pc = new PlayerCharacter(campaign, data.name, { ...data.stats });
  pc.id = data.id as CharacterId;
  return pc;
}
