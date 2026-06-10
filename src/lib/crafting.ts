import { Brand } from "./brand";
import type { IItem, MaterialMap } from "./inventory";

/**
 * Author-chosen recipe identifier (semantic, like a key's code, but branded so a
 * stray `string` can't be passed where a recipe id is expected). Authors cast
 * their literal at the boundary: `"iron-sword" as RecipeId`.
 */
export type RecipeId = Brand<string, "RecipeId">;

/** A quantity of keys a key recipe consumes, matched by code. `qty` must be ≥ 1. */
export type KeyCost = { keyCode: string; qty: number };

/**
 * A crafting recipe: an id, an input cost, and a factory for the output. Two
 * shapes, mirroring the engine's item/key split — a `materials` recipe produces a
 * regular slotted item; a `keys` recipe produces a (free) key. Craft logic
 * discriminates with `"materials" in recipe`.
 *
 * Invariant: a `keys` recipe's `create` factory **must** return a key item
 * (`type === "key"`, built via `createKey`), since its output is placed in the
 * keyring; a `materials` recipe's `create` returns a regular slotted item.
 */
export type CraftingRecipe =
  | { id: RecipeId; materials: MaterialMap; create: () => IItem }
  | { id: RecipeId; keys: KeyCost[]; create: () => IItem };
