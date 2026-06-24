import { CampaignRegistry, type SceneBehavior, type FormationBehavior, type NpcBehavior } from "../serialization/registry";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";
import type { ICampaign } from "../campaign";
import type { Mechanic, JsonObject } from "../mechanics/mechanic.js";

declare const ITEM_KEYS: unique symbol;
declare const RECIPE_KEYS: unique symbol;
declare const CONDITION_KEYS: unique symbol;
declare const MECHANIC_KEYS: unique symbol;
declare const SCENE_KEYS: unique symbol;
declare const FORMATION_KEYS: unique symbol;
declare const NPC_KEYS: unique symbol;

/** A {@link CampaignRegistry} whose item/recipe/condition/mechanic/scene/formation/npc key literals are carried in the type (phantom — no runtime field). */
export type TypedRegistry<
  ItemKey extends string,
  RecipeKey extends string,
  ConditionKey extends string = never,
  MechanicKey extends string = never,
  SceneKey extends string = never,
  FormationKey extends string = never,
  NpcKey extends string = never,
> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: ItemKey;
  readonly [RECIPE_KEYS]?: RecipeKey;
  readonly [CONDITION_KEYS]?: ConditionKey;
  readonly [MECHANIC_KEYS]?: MechanicKey;
  readonly [SCENE_KEYS]?: SceneKey;
  readonly [FORMATION_KEYS]?: FormationKey;
  readonly [NPC_KEYS]?: NpcKey;
};

/** The registered item-factory key union of a {@link TypedRegistry} (falls back to `string`). */
export type ItemKeyOf<Registry> = Registry extends { readonly [ITEM_KEYS]?: infer K extends string } ? K : string;
/** The registered recipe key union of a {@link TypedRegistry} (falls back to `string`). */
export type RecipeKeyOf<Registry> = Registry extends { readonly [RECIPE_KEYS]?: infer K extends string } ? K : string;
/** The registered condition key union of a {@link TypedRegistry} (falls back to `string`). */
export type ConditionKeyOf<Registry> = Registry extends { readonly [CONDITION_KEYS]?: infer K extends string } ? K : string;
/**
 * The registered mechanic key union of a {@link TypedRegistry} (falls back to `string`).
 *
 * Use this in generic constraints when you want compile-time checking of mechanic keys
 * against a specific registry — e.g. `.useMechanic(key: MechanicKeyOf<Registry>)`.
 * If `Registry` is not a `TypedRegistry` produced by `defineRegistry`, this resolves to `string`.
 */
export type MechanicKeyOf<Registry> = Registry extends { readonly [MECHANIC_KEYS]?: infer K extends string } ? K : string;
/** The registered scene-behavior key union of a {@link TypedRegistry} (falls back to `string`). */
export type SceneKeyOf<Registry> = Registry extends { readonly [SCENE_KEYS]?: infer K extends string } ? K : string;
/** The registered formation-behavior key union of a {@link TypedRegistry} (falls back to `string`). */
export type FormationKeyOf<Registry> = Registry extends { readonly [FORMATION_KEYS]?: infer K extends string } ? K : string;
/** The registered NPC-behavior key union of a {@link TypedRegistry} (falls back to `string`). */
export type NpcKeyOf<Registry> = Registry extends { readonly [NPC_KEYS]?: infer K extends string } ? K : string;

/**
 * The config type of the mechanic registered under `Key` in `Registry`.
 *
 * Note: because `defineRegistry` encodes mechanic keys as `keyof Mechanics & string`
 * but does not thread the per-key config type through the phantom — only the key
 * union is captured — this resolves to `unknown`. It is a safe default: `.useMechanic`
 * (Task 6) will validate configs at `initialState` rather than at the call site.
 */
export type ConfigOf<Registry, Key extends string> =
  Registry extends { mechanicConfigs?: infer Configs }
    ? Key extends keyof Configs ? Configs[Key] : unknown
    : unknown;

/**
 * Defines a campaign registry from a const map of behaviors. Builds a normal
 * runtime {@link CampaignRegistry} (consumed unchanged by the server / Authority /
 * serialization) but returns it typed as a {@link TypedRegistry} carrying the
 * inferred item/recipe/condition/mechanic key literals, so the builder can compile-time-check
 * every key argument.
 */
export function defineRegistry<
  Items extends Record<string, () => Item>,
  Recipes extends Record<string, CraftingRecipe> = Record<string, never>,
  Conditions extends Record<string, (campaign: ICampaign) => boolean> = Record<string, never>,
  Mechanics extends Record<string, Mechanic<JsonObject, unknown, string>> = Record<string, never>,
  Scenes extends Record<string, SceneBehavior> = Record<string, never>,
  Formations extends Record<string, FormationBehavior> = Record<string, never>,
  Npcs extends Record<string, NpcBehavior> = Record<string, never>,
>(defs: {
  items: Items;
  recipes?: Recipes;
  scenes?: Scenes;
  formations?: Formations;
  npcs?: Npcs;
  conditions?: Conditions;
  mechanics?: Mechanics;
}): TypedRegistry<keyof Items & string, keyof Recipes & string, keyof Conditions & string, keyof Mechanics & string, keyof Scenes & string, keyof Formations & string, keyof Npcs & string> {
  const reg = new CampaignRegistry();
  for (const [key, factory] of Object.entries(defs.items)) reg.registerItem(key, factory);
  for (const [key, recipe] of Object.entries(defs.recipes ?? {})) reg.registerRecipe(key, recipe);
  for (const [key, scene] of Object.entries(defs.scenes ?? {})) reg.registerScene(key, scene);
  for (const [key, formation] of Object.entries(defs.formations ?? {})) reg.registerFormation(key, formation);
  for (const [key, predicate] of Object.entries(defs.conditions ?? {})) reg.registerCondition(key, predicate);
  for (const [key, mechanic] of Object.entries(defs.mechanics ?? {})) reg.registerMechanic(key, mechanic);
  for (const [key, npc] of Object.entries(defs.npcs ?? {})) reg.registerNpc(key, npc);
  return reg as TypedRegistry<keyof Items & string, keyof Recipes & string, keyof Conditions & string, keyof Mechanics & string, keyof Scenes & string, keyof Formations & string, keyof Npcs & string>;
}
