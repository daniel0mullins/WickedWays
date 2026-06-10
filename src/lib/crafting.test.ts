import { describe, expect, it } from "vitest";

import { createKey, type IItem } from "./inventory";
import type { CraftingRecipe, RecipeId } from "./crafting";

describe("CraftingRecipe", () => {
  it("models a materials recipe discriminated by its `materials` cost", () => {
    const recipe: CraftingRecipe = {
      id: "iron-sword" as RecipeId,
      materials: { metal: 2 },
      create: () => ({ name: "Iron Sword" }) as unknown as IItem,
    };

    expect("materials" in recipe).toBe(true);
    expect(recipe.create().name).toBe("Iron Sword");
  });

  it("models a keys recipe whose create() builds a key", () => {
    const recipe: CraftingRecipe = {
      id: "master-key" as RecipeId,
      keys: [{ keyCode: "bronze", qty: 2 }],
      create: () =>
        createKey({ name: "Master Key", keyCode: "master", consumeOnUse: false }),
    };

    expect("keys" in recipe).toBe(true);
    expect(recipe.create().type).toBe("key");
  });
});
