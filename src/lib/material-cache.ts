import { Brand } from "./brand";
import { MaterialMap } from "./inventory";
import { generateId } from "./util";

/** Unique identifier for a {@link MaterialCache}. */
export type MaterialCacheId = Brand<string, "MaterialCacheId">;

/**
 * Symbol-keyed method that empties a cache, returning what it held.
 *
 * Depletion is funnelled through this symbol so the one-way "harvested" state
 * transition cannot be driven from outside; only {@link Character.harvest} calls
 * it.
 */
export const DEPLETE = Symbol("depleteCache");

/**
 * A single-use pile of raw materials placed in a room. Harvesting empties it; a
 * depleted cache yields nothing further, which is what makes a re-firing scene's
 * repeated harvest a safe no-op (anti-farming).
 */
export interface IMaterialCache {
  id: MaterialCacheId;
  /** Whether this cache has already been harvested. */
  get depleted(): boolean;
  /** The materials still available to harvest (`{}` once depleted). */
  get contents(): Readonly<MaterialMap>;
  /**
   * Empties the cache and returns what it held. Idempotent: a depleted cache
   * returns `{}` and changes nothing. For {@link Character.harvest} only.
   */
  [DEPLETE](): MaterialMap;
}

/**
 * Default {@link IMaterialCache} implementation. Contents are copied on
 * construction so the caller's object cannot mutate the cache afterwards.
 */
export class MaterialCache implements IMaterialCache {
  id: MaterialCacheId;

  #contents: MaterialMap;
  #depleted = false;

  get depleted() {
    return this.#depleted;
  }

  get contents(): Readonly<MaterialMap> {
    return { ...this.#contents };
  }

  /** @param contents - The materials this cache yields when harvested. */
  constructor(contents: MaterialMap) {
    this.id = generateId<MaterialCacheId>();
    this.#contents = { ...contents };
  }

  [DEPLETE](): MaterialMap {
    if (this.#depleted) {
      return {};
    }
    this.#depleted = true;
    // Hand back an owned copy and empty the cache, so the returned map shares no
    // reference with internal state (consistent with the copy-out `contents` getter).
    const yielded = { ...this.#contents };
    this.#contents = {};
    return yielded;
  }
}
