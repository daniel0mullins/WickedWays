import { assemble } from "./assembler";
import { serializeCampaign } from "../serialization/serializer";
import type { CampaignRegistry } from "../serialization/registry";
import type { Campaign } from "../campaign";
import type { CampaignSnapshot } from "../serialization/types";
import type { Direction } from "../room";
import type { Stats } from "../character/stats";
import type { MaterialMap } from "../inventory";
import type { ArchetypeDef, CampaignTemplateDescription } from "./description";
import type { ItemKeyOf, RecipeKeyOf, ConditionKeyOf, MechanicKeyOf, SceneKeyOf, FormationKeyOf, NpcKeyOf, ExitKeyOf } from "./registry";
import { AuthoringError } from "./errors";
import type { OutcomeNarration } from "../victory";

/**
 * A chainable, ordering-agnostic builder that accumulates a
 * {@link CampaignTemplateDescription} and delegates to {@link assemble}.
 *
 * Generic over `ItemKey` (item key union) and `RecipeKey` (recipe key union)
 * from the registry, so `drops`/`items`/`lights`/`.recipe` are compile-time-checked
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
export class TemplateBuilder<ItemKey extends string, RecipeKey extends string, ConditionKey extends string = never, MechanicKey extends string = never, SceneKey extends string = never, FormationKey extends string = never, NpcKey extends string = never, ExitKey extends string = never> {
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
      npcs: [],
      formations: [],
      scenes: [],
      recipes: [],
      materials: [],
      winConditions: [],
      loseConditions: [],
      mechanics: [],
      timeoutNarration: undefined,
      endedNarration: undefined,
    };
  }

  /** Register a player-character archetype with the campaign. */
  archetype(def: ArchetypeDef): this {
    this.description.archetypes.push(def);
    return this;
  }

  /** Define a room in the game world. */
  room(name: string, opts: { description: string; dark?: boolean; spawnModifier?: number; lights?: ItemKey[] }): this {
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

  /** Define a directional exit between two rooms (forward refs are resolved at build time). When `behaviorKey` is provided, a registered door behavior (preconditions + script + state) is attached. */
  exit(from: string, direction: Direction, to: string, opts: { behaviorKey?: ExitKey; name?: string; initialState?: Record<string, unknown>; oneWay?: boolean } = {}): this {
    this.description.exits.push({ from, direction, to, ...opts });
    return this;
  }

  /** Define a non-player mob to place in the world. */
  mob(name: string, opts: {
    stats: Stats;
    room?: string;
    inventorySlots?: number;
    actionsPerRound?: number;
    drops?: ItemKey[];
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

  /**
   * Place a non-player character in the world. Its dialogue comes from a
   * registered NPC behavior (keyed), so the NPC survives serialization. Players
   * talk to it by finding it among a room's occupants and calling
   * `npc.dialogue(prompt)`.
   */
  npc(name: string, opts: { stats: Stats; room?: string; behavior: NpcKey }): this {
    this.description.npcs.push({
      name,
      stats: opts.stats,
      room: opts.room,
      behavior: opts.behavior,
    });
    return this;
  }

  /**
   * Opt a roving encounter formation into the campaign by registry key. Roving
   * formations spawn (weighted) when a player first enters a room, layered on top
   * of the per-room `spawnModifier` / `baseEncounterChance` checks.
   */
  formation(key: FormationKey, opts: { weight?: number } = {}): this {
    this.description.formations.push({ key, weight: opts.weight });
    return this;
  }

  /** Define a loot container placed in a room. */
  loot(name: string, opts: { room: string; items: ItemKey[]; description?: string }): this {
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

  /**
   * Attach a registered scene behavior to a room. The scene fires when a
   * character enters (or exits, per `phase`) the room, gated by the behavior's
   * preconditions. `key` references a behavior registered via `defineRegistry`'s
   * `scenes` map.
   */
  scene(room: string, key: SceneKey, opts: { phase?: "enter" | "exit"; initialState?: Record<string, unknown> } = {}): this {
    this.description.scenes.push({ room, key, phase: opts.phase, initialState: opts.initialState });
    return this;
  }

  /** Deposit initial materials into the campaign's shared pool. */
  materials(source: string, map: MaterialMap): this {
    this.description.materials.push({ source, map });
    return this;
  }

  /** Unlock a recipe for the party from the start. */
  recipe(key: RecipeKey): this {
    this.description.recipes.push(key);
    return this;
  }

  /** Add a win condition (registry key) with optional surface-agnostic prose. */
  winWhen(key: ConditionKey, narration?: OutcomeNarration): this {
    this.description.winConditions.push({ key, narration });
    return this;
  }

  /** Add a loss condition (registry key) with optional surface-agnostic prose. */
  loseWhen(key: ConditionKey, narration?: OutcomeNarration): this {
    this.description.loseConditions.push({ key, narration });
    return this;
  }

  /**
   * Opt this campaign into a custom mechanic by registry key. Order is preserved
   * and determines hook-execution precedence — mechanics registered earlier run first.
   * An earlier `modifyDamage` that returns `{ value, final: true }` pre-empts all
   * later transformers.
   *
   * The mechanic set is static: `.useMechanic` may only be called at authoring time,
   * not after the campaign has started.
   *
   * @param key    - A key registered in the {@link TypedRegistry} via `defineRegistry`.
   * @param config - Optional configuration forwarded verbatim to `Mechanic.initialState`.
   */
  useMechanic<Key extends MechanicKey>(key: Key, config?: unknown): this {
    if (this.description.mechanics.some((m) => m.key === key)) {
      throw new AuthoringError([`Mechanic '${key}' is already enabled.`]);
    }
    this.description.mechanics.push({ key, config });
    return this;
  }

  /** Set the fallback prose shown when the campaign times out at maxRounds. */
  onTimeout(narration: OutcomeNarration): this {
    this.description.timeoutNarration = narration;
    return this;
  }

  /** Set the fallback prose shown when the GM manually ends the campaign. */
  onEnd(narration: OutcomeNarration): this {
    this.description.endedNarration = narration;
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
export function authorTemplate<Registry extends CampaignRegistry>(
  title: string,
  registry: Registry,
  opts?: { rng?: () => number; maxRounds?: number; baseEncounterChance?: number },
): TemplateBuilder<ItemKeyOf<Registry>, RecipeKeyOf<Registry>, ConditionKeyOf<Registry>, MechanicKeyOf<Registry>, SceneKeyOf<Registry>, FormationKeyOf<Registry>, NpcKeyOf<Registry>, ExitKeyOf<Registry>> {
  return new TemplateBuilder<ItemKeyOf<Registry>, RecipeKeyOf<Registry>, ConditionKeyOf<Registry>, MechanicKeyOf<Registry>, SceneKeyOf<Registry>, FormationKeyOf<Registry>, NpcKeyOf<Registry>, ExitKeyOf<Registry>>(title, registry, opts);
}
