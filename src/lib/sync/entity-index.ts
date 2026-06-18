import { ProceduralViolation } from "../util";
import { serializeCampaignWithIndex } from "../serialization/serializer";
import type { ICampaign } from "../campaign";
import type { ICharacter } from "../character/character";
import type { IRoom } from "../room";
import type { IItem } from "../inventory";
import type { ILoot } from "../loot";
import type { IMaterialCache } from "../material-cache";

/**
 * Typed id→live-instance resolution over a campaign's reachable-from-party graph.
 *
 * Built transiently per command from the same walk that produces the `before`
 * snapshot (see {@link serializeCampaignWithIndex}), so it can never go stale.
 * The {@link Resolver} uses it to turn a command's argument ids into the live
 * objects the engine actions require.
 */
export class EntityIndex {
  constructor(private readonly raw: Map<string, unknown>) {}

  /** Builds an index from a campaign's current reachable graph. */
  static fromCampaign(campaign: ICampaign): EntityIndex {
    return new EntityIndex(serializeCampaignWithIndex(campaign).index);
  }

  /** Returns `true` if `id` is present in the index. */
  has(id: string): boolean {
    return this.raw.has(id);
  }

  private get<T>(id: string, kind: string): T {
    const found = this.raw.get(id);
    if (found == null) {
      throw new ProceduralViolation(`Unknown ${kind} id '${id}'.`);
    }
    return found as T;
  }

  /** Returns the character for `id`; throws {@link ProceduralViolation} if not found. */
  character(id: string): ICharacter {
    return this.get<ICharacter>(id, "character");
  }
  /** Returns the character for `id`, or `undefined` if absent. */
  tryCharacter(id: string): ICharacter | undefined {
    return this.raw.get(id) as ICharacter | undefined;
  }
  /** Returns the room for `id`; throws {@link ProceduralViolation} if not found. */
  room(id: string): IRoom {
    return this.get<IRoom>(id, "room");
  }
  /** Returns the item for `id`; throws {@link ProceduralViolation} if not found. */
  item(id: string): IItem {
    return this.get<IItem>(id, "item");
  }
  /** Returns the loot box for `id`; throws {@link ProceduralViolation} if not found. */
  loot(id: string): ILoot {
    return this.get<ILoot>(id, "loot");
  }
  /** Returns the material cache for `id`; throws {@link ProceduralViolation} if not found. */
  materialCache(id: string): IMaterialCache {
    return this.get<IMaterialCache>(id, "materialCache");
  }
}
