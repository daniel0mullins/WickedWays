import { ProceduralViolation } from "../util";
import { Campaign } from "../campaign";
import type { CampaignId } from "../campaign";
import { hydrateItem } from "../inventory";
import { hydrateLoot } from "../loot";
import { hydrateMaterialCache } from "../material-cache";
import { constructBareRoom } from "../room";
import { constructBareCharacter } from "../character/hydrate";
import { HydrateContext } from "./context";
import { HYDRATE, HYDRATE_CATALOG, HYDRATE_CODEX_ENTRIES } from "./symbols";
import { DEFAULT_CHAT_POLICY } from "../chat-policy";
import { DEFAULT_AV_POLICY } from "../av-policy";
import { SCHEMA_VERSION } from "./types";
import type { CampaignSnapshot } from "./types";
import type { CampaignRegistry } from "./registry";

/**
 * Reconstructs a full campaign from a snapshot in two passes.
 *
 * Pass 1 constructs and indexes every entity with placeholder references; pass 2
 * wires all cross-references. The catalog (archetypes + recipes) is restored
 * between the shell construction and pass-1 character construction so player
 * characters can resolve their archetype during hydration.
 *
 * Fail-fast: an unknown `schemaVersion` throws via {@link migrate}; any dangling
 * reference throws via the `HydrateContext` resolvers.
 *
 * @param data - A snapshot produced by `serializeCampaign`.
 * @param opts - The author behavior registry and an optional rng (re-injected,
 *   never serialized; defaults to `Math.random`).
 * @returns The fully restored {@link Campaign}.
 */
export function deserializeCampaign(
  data: CampaignSnapshot,
  opts: { registry: CampaignRegistry; rng?: () => number },
): Campaign {
  migrate(data);
  const rng = opts.rng ?? Math.random;
  const ctx = new HydrateContext(opts.registry, rng);

  const core = data.campaign;

  // Campaign shell first: characters need the back-reference, and the catalog
  // must be restored before any character hydrates.
  const campaign = new Campaign({ title: core.title, maxRounds: core.maxRounds, knownRecipes: [], rng });
  campaign.id = core.id as CampaignId;
  ctx.put(campaign.id, campaign);
  campaign[HYDRATE_CATALOG](core, opts.registry);

  // PASS 1 — construct + index every entity (no cross-references yet).
  // Items before loot/characters so their contents/inventory resolve in pass 2.
  for (const itemData of data.items) hydrateItem(itemData, ctx);
  for (const lootData of data.loot) hydrateLoot(lootData, ctx);
  for (const cacheData of data.materialCaches) hydrateMaterialCache(cacheData, ctx);
  const rooms = data.rooms.map((r) => {
    const room = constructBareRoom(r);
    ctx.put(room.id, room);
    return { room, data: r };
  });
  const chars = data.characters.map((d) => {
    const ch = constructBareCharacter(d, campaign);
    ctx.put(ch.id, ch);
    return { ch, data: d };
  });

  // PASS 2 — wire references.
  campaign[HYDRATE](core, ctx);
  campaign[HYDRATE_CODEX_ENTRIES](data.codex);
  for (const { ch, data: d } of chars) ch[HYDRATE](d, ctx);
  for (const { room, data: r } of rooms) room[HYDRATE](r, ctx);

  return campaign;
}

/** Upgrades older snapshots to the current schema; rejects unknown/newer versions. */
export function migrate(data: CampaignSnapshot): CampaignSnapshot {
  // v2 → v3: chat policy was introduced in schema 3. Pre-chat campaigns get the
  // default (all features on); authors disable by re-authoring the template.
  if (data.schemaVersion === 2) {
    data.campaign.chatPolicy = { ...DEFAULT_CHAT_POLICY };
    data.schemaVersion = 3;
  }
  // v3 → v4: A/V policy introduced in schema 4. Pre-A/V campaigns get the default.
  if (data.schemaVersion === 3) {
    data.campaign.avPolicy = { ...DEFAULT_AV_POLICY };
    data.schemaVersion = 4;
  }
  // v4 → v5: custom mechanics introduced in schema 5. Pre-mechanics campaigns
  // have none and hydrate inert (preserving the opt-in invariant).
  if (data.schemaVersion === 4) {
    data.campaign.mechanics = [];
    data.schemaVersion = 5;
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new ProceduralViolation(
      `Unsupported snapshot schemaVersion ${data.schemaVersion}; expected ${SCHEMA_VERSION}.`,
    );
  }
  return data;
}
