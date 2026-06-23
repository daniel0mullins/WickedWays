import { Brand } from "./brand";
import { MaterialMap } from "./inventory";
import { generateId } from "./util";
import type { Presentation } from "./presentation";
import { HYDRATE, SERIALIZE } from "./serialization/symbols";
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

/** Constructor options for a {@link MaterialCache}. */
export interface MaterialCacheOptions {
  /** The materials this cache yields when harvested. */
  contents: MaterialMap;
  /** Optional presentation metadata (image/sound). */
  presentation?: Presentation;
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

  /** @param opts - The cache contents and optional presentation. */
  constructor(opts: MaterialCacheOptions) {
    this.id = generateId<MaterialCacheId>();
    this.#contents = { ...opts.contents };
    this.#presentation = opts.presentation;
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

  /** In-place restore of mutable cache state. Safe to re-apply (idempotent). */
  [HYDRATE](data: MaterialCacheSnapshot): void {
    this.#contents = { ...data.contents };
    this.#depleted = data.depleted;
  }
}

/**
 * Reconstructs a {@link MaterialCache} from its snapshot.
 *
 * @param data - Plain-data snapshot produced by {@link MaterialCache[SERIALIZE]}.
 * @param ctx - Hydration context carrying the id→instance index and registry.
 * @returns The reconstructed cache, registered in `ctx`.
 */
export function hydrateMaterialCache(data: MaterialCacheSnapshot, ctx: HydrateContext): MaterialCache {
  const cache = new MaterialCache({ contents: {} });
  cache.id = data.id as MaterialCacheId;
  cache[HYDRATE](data);
  ctx.put(cache.id, cache);
  return cache;
}
