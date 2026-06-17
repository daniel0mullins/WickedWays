import { ProceduralViolation } from "../util";
import type { CampaignRegistry } from "./registry";
import type { IItem } from "../inventory";
import type { ILoot } from "../loot";
import type { IRoom } from "../room";
import type { ICharacter } from "../character/character";
import type { IMaterialCache } from "../material-cache";

/** Carries the id→instance index, the registry, and the rng through reconstruction. */
export class HydrateContext {
  readonly index = new Map<string, unknown>();
  constructor(
    readonly registry: CampaignRegistry,
    readonly rng: () => number,
  ) {}

  put(id: string, instance: unknown): void {
    this.index.set(id, instance);
  }
  #get<T>(id: string, kind: string): T {
    const found = this.index.get(id);
    if (found === undefined) {
      throw new ProceduralViolation(`Corrupt snapshot: dangling ${kind} id '${id}'.`);
    }
    return found as T;
  }
  item(id: string): IItem {
    return this.#get<IItem>(id, "item");
  }
  loot(id: string): ILoot {
    return this.#get<ILoot>(id, "loot");
  }
  materialCache(id: string): IMaterialCache {
    return this.#get<IMaterialCache>(id, "materialCache");
  }
  room(id: string): IRoom {
    return this.#get<IRoom>(id, "room");
  }
  character(id: string): ICharacter {
    return this.#get<ICharacter>(id, "character");
  }
}
