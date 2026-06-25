import { Campaign } from "../campaign";
import { HydrateContext } from "../serialization/context";
import { HYDRATE, HYDRATE_CATALOG, HYDRATE_CODEX_ENTRIES } from "../serialization/symbols";
import { serializeCampaignWithIndex } from "../serialization/serializer";
import { hydrateItem } from "../inventory";
import { hydrateMaterialCache } from "../material-cache";
import { constructBareRoom } from "../room";
import { constructBareCharacter } from "../character/hydrate";
import { Loot } from "../loot";
import type { Item } from "../inventory";
import type { MaterialCache } from "../material-cache";
import type { CampaignRegistry } from "../serialization/registry";
import type { Delta, EntitySnapshot } from "./types";
import type {
  RoomSnapshot,
  CharacterSnapshot,
  ItemSnapshot,
  LootSnapshot,
  MaterialCacheSnapshot,
} from "../serialization/types";
import type { Room } from "../room";
import type { Character } from "../character/character";
import type { LootId } from "../loot";

/**
 * Applies a {@link Delta} to a replica campaign by patching state. Never runs
 * game logic and never draws rng — replicas trust the ordered log and converge
 * by re-hydrating changed entities in place and constructing created ones.
 */
export class DeltaApplier {
  /**
   * Patches `replica` in place to reflect `delta`. Two-pass: pass 1 constructs
   * created entities and re-hydrates ref-free changed ones; pass 2 wires
   * cross-references. Never runs game logic and never draws rng.
   */
  apply(replica: Campaign, delta: Delta, opts: { registry: CampaignRegistry; rng: () => number }): void {
    const { index } = serializeCampaignWithIndex(replica);
    const ctx = new HydrateContext(opts.registry, opts.rng);
    for (const [id, instance] of index) ctx.put(id, instance);

    const byType = (entries: EntitySnapshot[], type: EntitySnapshot["type"]) =>
      entries.filter((e) => e.type === type).map((e) => e.data);

    // PASS 1 — created (id-resolvable order).
    for (const data of byType(delta.created, "item") as ItemSnapshot[]) {
      hydrateItem(data, ctx); // indexes itself
    }
    for (const data of byType(delta.created, "materialCache") as MaterialCacheSnapshot[]) {
      hydrateMaterialCache(data, ctx);
    }
    for (const data of byType(delta.created, "loot") as LootSnapshot[]) {
      const loot = new Loot({ description: data.description, contents: [] });
      loot.id = data.id as LootId;
      ctx.put(loot.id, loot); // contents wired in pass 2
    }
    for (const data of byType(delta.created, "room") as RoomSnapshot[]) {
      const room = constructBareRoom(data);
      ctx.put(room.id, room);
    }
    for (const data of byType(delta.created, "character") as CharacterSnapshot[]) {
      const ch = constructBareCharacter(data, replica, ctx.registry);
      ctx.put(ch.id, ch);
    }

    // PASS 1b — changed ref-free entities, in place. Casts bridge the
    // interface-typed `ctx` getters to the concrete classes that own `[HYDRATE]`.
    for (const data of byType(delta.changed, "item") as ItemSnapshot[]) {
      (ctx.item(data.id) as Item)[HYDRATE](data);
    }
    for (const data of byType(delta.changed, "materialCache") as MaterialCacheSnapshot[]) {
      (ctx.materialCache(data.id) as MaterialCache)[HYDRATE](data);
    }

    // PASS 2 — ref-bearing hydrate for created ∪ changed.
    for (const data of [...byType(delta.created, "loot"), ...byType(delta.changed, "loot")] as LootSnapshot[]) {
      (ctx.loot(data.id) as Loot)[HYDRATE](data, ctx);
    }
    for (const data of [...byType(delta.created, "room"), ...byType(delta.changed, "room")] as RoomSnapshot[]) {
      (ctx.room(data.id) as Room)[HYDRATE](data, ctx);
    }
    for (const data of [...byType(delta.created, "character"), ...byType(delta.changed, "character")] as CharacterSnapshot[]) {
      (ctx.character(data.id) as Character)[HYDRATE](data, ctx);
    }

    // campaignCore — catalog, core, codex.
    // Ordering note: HYDRATE_CATALOG currently runs after PASS-2 character hydrate,
    // which is safe ONLY because no command introduces a new archetype in the same
    // delta as a character selecting it (archetypes are setup-baseline, present in
    // every replica). The deserializer deliberately applies the catalog BEFORE
    // character hydrate; if a future command ever adds an archetype + a character
    // referencing it atomically, HYDRATE_CATALOG must move ahead of PASS 2 here.
    if (delta.campaignCore) {
      replica[HYDRATE_CATALOG](delta.campaignCore.core, opts.registry);
      replica[HYDRATE](delta.campaignCore.core, ctx);
      replica[HYDRATE_CODEX_ENTRIES](delta.campaignCore.codex);
    }

    // No-op for replica state — removal is effected by the changed holder's
    // collection reset during PASS 2. The index delete only keeps this transient
    // index tidy (symmetry with `created` registration, useful for debugging).
    for (const id of delta.removed) ctx.index.delete(id);
  }
}
