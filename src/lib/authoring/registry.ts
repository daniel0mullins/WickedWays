import { CampaignRegistry, type SceneBehavior, type FormationBehavior } from "../serialization/registry";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";
import type { ICampaign } from "../campaign";

declare const ITEM_KEYS: unique symbol;
declare const RECIPE_KEYS: unique symbol;
declare const CONDITION_KEYS: unique symbol;

/** A {@link CampaignRegistry} whose item/recipe/condition key literals are carried in the type (phantom — no runtime field). */
export type TypedRegistry<IK extends string, RK extends string, CK extends string = never> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: IK;
  readonly [RECIPE_KEYS]?: RK;
  readonly [CONDITION_KEYS]?: CK;
};

/** The registered item-factory key union of a {@link TypedRegistry} (falls back to `string`). */
export type ItemKeyOf<R> = R extends { readonly [ITEM_KEYS]?: infer K extends string } ? K : string;
/** The registered recipe key union of a {@link TypedRegistry} (falls back to `string`). */
export type RecipeKeyOf<R> = R extends { readonly [RECIPE_KEYS]?: infer K extends string } ? K : string;
/** The registered condition key union of a {@link TypedRegistry} (falls back to `string`). */
export type ConditionKeyOf<R> = R extends { readonly [CONDITION_KEYS]?: infer K extends string } ? K : string;

/**
 * Defines a campaign registry from a const map of behaviors. Builds a normal
 * runtime {@link CampaignRegistry} (consumed unchanged by the server / Authority /
 * serialization) but returns it typed as a {@link TypedRegistry} carrying the
 * inferred item/recipe/condition key literals, so the builder can compile-time-check
 * every key argument.
 */
export function defineRegistry<
  I extends Record<string, () => Item>,
  R extends Record<string, CraftingRecipe> = Record<string, never>,
  C extends Record<string, (campaign: ICampaign) => boolean> = Record<string, never>,
>(defs: {
  items: I;
  recipes?: R;
  scenes?: Record<string, SceneBehavior>;
  formations?: Record<string, FormationBehavior>;
  conditions?: C;
}): TypedRegistry<keyof I & string, keyof R & string, keyof C & string> {
  const reg = new CampaignRegistry();
  for (const [key, factory] of Object.entries(defs.items)) reg.registerItem(key, factory);
  for (const [key, recipe] of Object.entries(defs.recipes ?? {})) reg.registerRecipe(key, recipe);
  for (const [key, scene] of Object.entries(defs.scenes ?? {})) reg.registerScene(key, scene);
  for (const [key, formation] of Object.entries(defs.formations ?? {})) reg.registerFormation(key, formation);
  for (const [key, predicate] of Object.entries(defs.conditions ?? {})) reg.registerCondition(key, predicate);
  return reg as TypedRegistry<keyof I & string, keyof R & string, keyof C & string>;
}
