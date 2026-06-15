import type { Brand } from "./brand";
import type { Stats } from "./character/stats";
import type { Status } from "./status";

/**
 * Author-chosen archetype identifier, branded so a stray `string` can't be
 * passed where an archetype id is expected. Authors cast their literal at the
 * boundary: `"brawler" as ArchetypeId`.
 */
export type ArchetypeId = Brand<string, "ArchetypeId">;

/**
 * An authored character role registered on a {@link import("./campaign").ICampaign}.
 * Selecting it modifies a player character's baseline exactly once: stat deltas
 * layer onto the provided base stats, the slot delta adjusts inventory capacity,
 * and the immunities become a standing passive trait. Plain declarative data —
 * no class or factory, in the style of the item/recipe/formation descriptors.
 */
export interface Archetype {
  /** Stable identifier. */
  id: ArchetypeId;
  /** Display name. */
  name: string;
  /** Deltas added once to base stats at selection. A missing stat contributes +0. */
  statModifiers?: Partial<Stats>;
  /** Delta added once to inventory slot capacity (resulting capacity floored at 0). */
  inventorySlots?: number;
  /**
   * Standing status immunities granted while this archetype is held. Covers
   * Panic/Fear/Confused; KO is never immunizable, so a listed KO is ignored
   * (consistent with item immunities today).
   */
  immunities?: Status[];
}
