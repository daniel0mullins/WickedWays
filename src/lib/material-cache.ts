import { Brand } from "./brand";
import { MaterialMap } from "./inventory";
import { generateId } from "./util";
import type { Presentation } from "./presentation";
import { SERIALIZE } from "./serialization/symbols";
import type { MaterialCacheSnapshot } from "./serialization/types";
import type { HydrateContext } from "./serialization/context";

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
  /** Optional presentation metadata (image/sound), or `undefined` if none. */
  get presentation(): Presentation | undefined;
  /** Returns a plain-data snapshot of this material cache. See {@link SERIALIZE}. */
  [SERIALIZE](): MaterialCacheSnapshot;
}

/**
 * Default {@link IMaterialCache} implementation. Contents are copied on
 * construction so the caller's object cannot mutate the cache afterwards.
 */
export class MaterialCache implements IMaterialCache {
  id: MaterialCacheId;

  #contents: MaterialMap;
  #depleted = false;
  #presentation?: Presentation;

  get depleted() {
    return this.#depleted;
  }

  get contents(): Readonly<MaterialMap> {
    return { ...this.#contents };
  }

  get presentation(): Presentation | undefined {
    return this.#presentation;
  }

  /** @param contents - The materials this cache yields when harvested. */
  constructor(contents: MaterialMap, presentation?: Presentation) {
    this.id = generateId<MaterialCacheId>();
    this.#contents = { ...contents };
    this.#presentation = presentation;
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

  /** Returns a plain-data snapshot suitable for persistence. */
  [SERIALIZE](): MaterialCacheSnapshot {
    return {
      id: this.id,
      contents: { ...this.#contents },
      depleted: this.#depleted,
    };
  }
}

/**
 * Reconstructs a {@link MaterialCache} from its snapshot.
 *
 * An intact cache is restored by constructing with its contents; a depleted
 * cache is constructed with an empty map and `DEPLETE` is called so the
 * one-way state transition is respected.
 *
 * @param data - Plain-data snapshot produced by {@link MaterialCache[SERIALIZE]}.
 * @param ctx - Hydration context carrying the id→instance index and registry.
 * @returns The reconstructed cache, registered in `ctx`.
 */
export function hydrateMaterialCache(data: MaterialCacheSnapshot, ctx: HydrateContext): MaterialCache {
  const cache = new MaterialCache(data.contents);
  cache.id = data.id as MaterialCacheId;
  if (data.depleted) {
    cache[DEPLETE]();
  }
  ctx.put(cache.id, cache);
  return cache;
}
