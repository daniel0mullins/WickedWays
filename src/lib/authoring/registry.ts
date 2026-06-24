import { CampaignRegistry, type SceneBehavior, type FormationBehavior } from "../serialization/registry";
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

/** A {@link CampaignRegistry} whose item/recipe/condition/mechanic/scene/formation key literals are carried in the type (phantom — no runtime field). */
export type TypedRegistry<
  IK extends string,
  RK extends string,
  CK extends string = never,
  MK extends string = never,
  SK extends string = never,
  FK extends string = never,
> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: IK;
  readonly [RECIPE_KEYS]?: RK;
  readonly [CONDITION_KEYS]?: CK;
  readonly [MECHANIC_KEYS]?: MK;
  readonly [SCENE_KEYS]?: SK;
  readonly [FORMATION_KEYS]?: FK;
};

/** The registered item-factory key union of a {@link TypedRegistry} (falls back to `string`). */
export type ItemKeyOf<R> = R extends { readonly [ITEM_KEYS]?: infer K extends string } ? K : string;
/** The registered recipe key union of a {@link TypedRegistry} (falls back to `string`). */
export type RecipeKeyOf<R> = R extends { readonly [RECIPE_KEYS]?: infer K extends string } ? K : string;
/** The registered condition key union of a {@link TypedRegistry} (falls back to `string`). */
export type ConditionKeyOf<R> = R extends { readonly [CONDITION_KEYS]?: infer K extends string } ? K : string;
/**
 * The registered mechanic key union of a {@link TypedRegistry} (falls back to `string`).
 *
 * Use this in generic constraints when you want compile-time checking of mechanic keys
 * against a specific registry — e.g. `.useMechanic(key: MechanicKeyOf<R>)`.
 * If `R` is not a `TypedRegistry` produced by `defineRegistry`, this resolves to `string`.
 */
export type MechanicKeyOf<R> = R extends { readonly [MECHANIC_KEYS]?: infer K extends string } ? K : string;
/** The registered scene-behavior key union of a {@link TypedRegistry} (falls back to `string`). */
export type SceneKeyOf<R> = R extends { readonly [SCENE_KEYS]?: infer K extends string } ? K : string;
/** The registered formation-behavior key union of a {@link TypedRegistry} (falls back to `string`). */
export type FormationKeyOf<R> = R extends { readonly [FORMATION_KEYS]?: infer K extends string } ? K : string;

/**
 * The Cfg type of the mechanic registered under key K in registry R.
 *
 * Note: because `defineRegistry` encodes mechanic keys as `keyof M & string` but
 * does not thread the per-key `Cfg` type through the phantom — only the key union
 * is captured — this resolves to `unknown`. It is a safe default: `.useMechanic`
 * (Task 6) will validate configs at `initialState` rather than at the call site.
 */
export type ConfigOf<R, K extends string> =
  R extends { mechanicConfigs?: infer M }
    ? K extends keyof M ? M[K] : unknown
    : unknown;

/**
 * Defines a campaign registry from a const map of behaviors. Builds a normal
 * runtime {@link CampaignRegistry} (consumed unchanged by the server / Authority /
 * serialization) but returns it typed as a {@link TypedRegistry} carrying the
 * inferred item/recipe/condition/mechanic key literals, so the builder can compile-time-check
 * every key argument.
 */
export function defineRegistry<
  I extends Record<string, () => Item>,
  R extends Record<string, CraftingRecipe> = Record<string, never>,
  C extends Record<string, (campaign: ICampaign) => boolean> = Record<string, never>,
  M extends Record<string, Mechanic<JsonObject, unknown, string>> = Record<string, never>,
  S extends Record<string, SceneBehavior> = Record<string, never>,
  F extends Record<string, FormationBehavior> = Record<string, never>,
>(defs: {
  items: I;
  recipes?: R;
  scenes?: S;
  formations?: F;
  conditions?: C;
  mechanics?: M;
}): TypedRegistry<keyof I & string, keyof R & string, keyof C & string, keyof M & string, keyof S & string, keyof F & string> {
  const reg = new CampaignRegistry();
  for (const [key, factory] of Object.entries(defs.items)) reg.registerItem(key, factory);
  for (const [key, recipe] of Object.entries(defs.recipes ?? {})) reg.registerRecipe(key, recipe);
  for (const [key, scene] of Object.entries(defs.scenes ?? {})) reg.registerScene(key, scene);
  for (const [key, formation] of Object.entries(defs.formations ?? {})) reg.registerFormation(key, formation);
  for (const [key, predicate] of Object.entries(defs.conditions ?? {})) reg.registerCondition(key, predicate);
  for (const [key, mechanic] of Object.entries(defs.mechanics ?? {})) reg.registerMechanic(key, mechanic);
  return reg as TypedRegistry<keyof I & string, keyof R & string, keyof C & string, keyof M & string, keyof S & string, keyof F & string>;
}
