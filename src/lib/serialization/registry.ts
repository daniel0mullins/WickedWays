import { ProceduralViolation } from "../util";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";
import type { ICampaign } from "../campaign";
import type { IMob } from "../character/mob";
import type { IRoom } from "../room";
import type { IDialogue } from "../character/non-player-character";
import type { Mechanic, JsonObject, MechanicCue } from "../mechanics/mechanic.js";
import type { ExitBehavior } from "../exit";

export interface SceneBehavior {
  preconditions: ((room: IRoom, state: never) => boolean)[];
  script: (room: IRoom, state: never) => MechanicCue[] | void;
}
export interface FormationBehavior {
  build: (campaign: ICampaign) => IMob[];
}
/** An NPC's dialogue behavior: its default line and the (function-carrying) dialogue blocks. */
export interface NpcBehavior {
  initialDialogue: string;
  dialogue: IDialogue[];
}

/**
 * Author-supplied behaviors keyed by stable strings; the restore-side source of
 * every closure that cannot be serialized (scene scripts, item factories,
 * crafting recipes, encounter-table formations).
 *
 * Populate the registry **before** calling `deserializeCampaign`. Every
 * `behaviorKey` referenced in the snapshot must have a matching entry or
 * deserialization throws a {@link ProceduralViolation}.
 *
 * Keys are arbitrary stable strings chosen by the game author — typically
 * namespaced to avoid collisions (e.g. `"items/sword"`, `"scenes/ambush"`).
 */
export class CampaignRegistry {
  #scenes = new Map<string, SceneBehavior>();
  #recipes = new Map<string, CraftingRecipe>();
  #formations = new Map<string, FormationBehavior>();
  #items = new Map<string, () => Item>();
  #conditions = new Map<string, (campaign: ICampaign) => boolean>();
  #mechanics = new Map<string, Mechanic<JsonObject, unknown, string>>();
  #npcs = new Map<string, NpcBehavior>();
  #exits = new Map<string, ExitBehavior>();

  /**
   * Registers a {@link SceneBehavior} (preconditions + script) under `key`.
   * Must match the `behaviorKey` passed to each `Scene` constructor that
   * needs to survive serialization.
   */
  registerScene(key: string, behavior: SceneBehavior): void {
    this.#scenes.set(key, behavior);
  }
  /**
   * Registers a {@link CraftingRecipe} under `key`.
   * Must match the `behaviorKey` used when the recipe was added to the campaign.
   */
  registerRecipe(key: string, recipe: CraftingRecipe): void {
    this.#recipes.set(key, recipe);
  }
  /**
   * Registers a {@link FormationBehavior} (mob-spawning factory) under `key`.
   * Must match the `behaviorKey` on every encounter-table formation entry.
   */
  registerFormation(key: string, behavior: FormationBehavior): void {
    this.#formations.set(key, behavior);
  }
  /**
   * Registers an {@link Item} factory under `key`.
   * Must match the `behaviorKey` passed to the {@link Item} constructor for
   * every non-key item that needs to survive serialization.
   */
  registerItem(key: string, factory: () => Item): void {
    this.#items.set(key, factory);
  }
  /**
   * Registers a victory/defeat predicate under `key`.
   * Must match the condition key referenced by a campaign template / snapshot.
   */
  registerCondition(key: string, predicate: (campaign: ICampaign) => boolean): void {
    this.#conditions.set(key, predicate);
  }
  /**
   * Registers a {@link Mechanic} under `key`.
   * Must match the mechanic key used when opting a campaign into this mechanic
   * via `.useMechanic(key, config?)`.
   *
   * On deserialization, `registry.mechanic(key)` re-binds the behavior to the
   * persisted `{ key, state }` entry. If the key is absent the deserializer throws
   * a {@link ProceduralViolation} — register all mechanics before calling
   * `deserializeCampaign`.
   */
  registerMechanic(key: string, mechanic: Mechanic<JsonObject, unknown, string>): void {
    this.#mechanics.set(key, mechanic);
  }
  /**
   * Registers an {@link NpcBehavior} (dialogue + preconditions) under `key`.
   * Must match the `behaviorKey` carried by every {@link NonPlayerCharacter} that
   * needs to survive serialization — its dialogue closures re-bind from here.
   */
  registerNpc(key: string, behavior: NpcBehavior): void {
    this.#npcs.set(key, behavior);
  }
  /**
   * Registers an {@link ExitBehavior} (preconditions + script + messages) under `key`.
   * Must match the `behaviorKey` passed into every {@link Exit} that needs to survive
   * serialization — preconditions and the script re-bind from here on hydrate.
   */
  registerExit(key: string, behavior: ExitBehavior): void {
    this.#exits.set(key, behavior);
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
  condition(key: string): (campaign: ICampaign) => boolean {
    return this.#require(this.#conditions.get(key), "condition", key);
  }
  mechanic(key: string): Mechanic<JsonObject, unknown, string> {
    return this.#require(this.#mechanics.get(key), "mechanic", key);
  }
  npc(key: string): NpcBehavior {
    return this.#require(this.#npcs.get(key), "npc", key);
  }
  exit(key: string): ExitBehavior {
    return this.#require(this.#exits.get(key), "exit", key);
  }

  #require<T>(value: T | undefined, kind: string, key: string): T {
    if (value === undefined) {
      throw new ProceduralViolation(`No ${kind} registered for key '${key}'.`);
    }
    return value;
  }
}
