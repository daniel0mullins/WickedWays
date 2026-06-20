import { assemble } from "./assembler";
import { serializeCampaign } from "../serialization/serializer";
import type { CampaignRegistry } from "../serialization/registry";
import type { Campaign } from "../campaign";
import type { CampaignSnapshot } from "../serialization/types";
import type { Direction } from "../room";
import type { Stats } from "../character/stats";
import type { MaterialMap } from "../inventory";
import type { ArchetypeDef, CampaignTemplateDescription } from "./description";
import type { ItemKeyOf, RecipeKeyOf } from "./registry";

/**
 * A chainable, ordering-agnostic builder that accumulates a
 * {@link CampaignTemplateDescription} and delegates to {@link assemble}.
 *
 * Generic over `IK` (item key union) and `RK` (recipe key union) from the
 * registry, so `drops`/`items`/`lights`/`.recipe` are compile-time-checked
 * against the registered keys.
 *
 * @example
 * ```ts
 * const reg = defineRegistry({ items: { "coin-item": makeCoin } });
 * const campaign = authorTemplate("Dungeon", reg)
 *   .room("start", { description: "entry" })
 *   .loot("chest", { room: "start", items: ["coin-item"] })
 *   .build();
 * ```
 */
export class TemplateBuilder<IK extends string, RK extends string> {
  /** @internal for orchestration (e.g. startSession) */
  readonly description: CampaignTemplateDescription;
  /** @internal for orchestration (e.g. startSession) */
  readonly registry: CampaignRegistry;

  constructor(title: string, registry: CampaignRegistry, opts: { rng?: () => number; maxRounds?: number; baseEncounterChance?: number } = {}) {
    this.registry = registry;
    this.description = {
      title,
      opts,
      archetypes: [],
      rooms: [],
      startRoom: undefined,
      exits: [],
      mobs: [],
      loot: [],
      caches: [],
      recipes: [],
      materials: [],
    };
  }

  /** Register a player-character archetype with the campaign. */
  archetype(def: ArchetypeDef): this {
    this.description.archetypes.push(def);
    return this;
  }

  /** Define a room in the game world. */
  room(name: string, opts: { description: string; dark?: boolean; spawnModifier?: number; lights?: IK[] }): this {
    this.description.rooms.push({
      name,
      description: opts.description,
      dark: opts.dark,
      spawnModifier: opts.spawnModifier,
      lights: opts.lights,
    });
    return this;
  }

  /** Set the room where players will start. */
  startRoom(name: string): this {
    this.description.startRoom = name;
    return this;
  }

  /** Define a one-way directional exit between two rooms (forward refs are resolved at build time). */
  exit(from: string, direction: Direction, to: string): this {
    this.description.exits.push({ from, direction, to });
    return this;
  }

  /** Define a non-player mob to place in the world. */
  mob(name: string, opts: {
    stats: Stats;
    room?: string;
    inventorySlots?: number;
    actionsPerRound?: number;
    drops?: IK[];
    baseEscapeChance?: number;
    materialDrops?: MaterialMap;
    lightAverse?: boolean;
  }): this {
    this.description.mobs.push({
      name,
      stats: opts.stats,
      room: opts.room,
      inventorySlots: opts.inventorySlots,
      actionsPerRound: opts.actionsPerRound,
      drops: opts.drops,
      baseEscapeChance: opts.baseEscapeChance,
      materialDrops: opts.materialDrops,
      lightAverse: opts.lightAverse,
    });
    return this;
  }

  /** Define a loot container placed in a room. */
  loot(name: string, opts: { room: string; items: IK[]; description?: string }): this {
    this.description.loot.push({
      name,
      room: opts.room,
      items: opts.items,
      description: opts.description,
    });
    return this;
  }

  /** Define a material cache placed in a room. */
  cache(name: string, opts: { room: string; materials: MaterialMap }): this {
    this.description.caches.push({ name, room: opts.room, materials: opts.materials });
    return this;
  }

  /** Deposit initial materials into the campaign's shared pool. */
  materials(source: string, map: MaterialMap): this {
    this.description.materials.push({ source, map });
    return this;
  }

  /** Unlock a recipe for the party from the start. */
  recipe(key: RK): this {
    this.description.recipes.push(key);
    return this;
  }

  /**
   * Validates and constructs the live, player-less, not-begun {@link Campaign}.
   * Forward references in exits/room placements are resolved here.
   *
   * @throws {@link AuthoringError} if any validation problems are found.
   */
  build(): Campaign {
    return assemble(this.description, this.registry).campaign;
  }

  /**
   * Produces a complete, JSON-serializable snapshot of the template's world.
   * Roots the BFS from the template's rooms (not party members, since there
   * are none), so all rooms are captured even in a player-less campaign.
   *
   * @throws {@link AuthoringError} if any validation problems are found.
   */
  toSnapshot(): CampaignSnapshot {
    const { campaign, rooms } = assemble(this.description, this.registry);
    return serializeCampaign(campaign, { rootRooms: rooms.values() });
  }
}

/**
 * Creates a fluent, chainable {@link TemplateBuilder} for authoring a campaign
 * template. Generic over the registry so item/recipe key arguments are
 * compile-time-checked.
 *
 * @param title - The campaign title.
 * @param registry - A typed registry (from {@link defineRegistry}) carrying
 *   the item/recipe key literals in its type.
 * @param opts - Optional campaign-level settings (rng, maxRounds, baseEncounterChance).
 */
export function authorTemplate<R extends CampaignRegistry>(
  title: string,
  registry: R,
  opts?: { rng?: () => number; maxRounds?: number; baseEncounterChance?: number },
): TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>> {
  return new TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>>(title, registry, opts);
}
