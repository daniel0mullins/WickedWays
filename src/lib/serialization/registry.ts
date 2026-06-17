import { ProceduralViolation } from "../util";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";
import type { ICampaign } from "../campaign";
import type { IMob } from "../character/mob";
import type { IRoom } from "../room";

export interface SceneBehavior {
  preconditions: ((room: IRoom, state: never) => boolean)[];
  script: (room: IRoom, state: never) => void;
}
export interface FormationBehavior {
  build: (campaign: ICampaign) => IMob[];
}

/** Author-supplied behaviors, keyed by stable strings; the restore-side source of every closure. */
export class CampaignRegistry {
  #scenes = new Map<string, SceneBehavior>();
  #recipes = new Map<string, CraftingRecipe>();
  #formations = new Map<string, FormationBehavior>();
  #items = new Map<string, () => Item>();

  registerScene(key: string, behavior: SceneBehavior): void {
    this.#scenes.set(key, behavior);
  }
  registerRecipe(key: string, recipe: CraftingRecipe): void {
    this.#recipes.set(key, recipe);
  }
  registerFormation(key: string, behavior: FormationBehavior): void {
    this.#formations.set(key, behavior);
  }
  registerItem(key: string, factory: () => Item): void {
    this.#items.set(key, factory);
  }

  scene(key: string): SceneBehavior {
    return this.#require(this.#scenes.get(key), "scene", key);
  }
  recipe(key: string): CraftingRecipe {
    return this.#require(this.#recipes.get(key), "recipe", key);
  }
  formation(key: string): FormationBehavior {
    return this.#require(this.#formations.get(key), "formation", key);
  }
  item(key: string): () => Item {
    return this.#require(this.#items.get(key), "item", key);
  }

  #require<T>(value: T | undefined, kind: string, key: string): T {
    if (value === undefined) {
      throw new ProceduralViolation(`No ${kind} registered for key '${key}'.`);
    }
    return value;
  }
}
