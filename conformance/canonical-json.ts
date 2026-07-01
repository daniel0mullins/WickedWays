/** Canonical form for snapshot comparison: deep-sort object keys, and sort the
 *  6 top-level entity arrays by `id` (they are id-keyed sets; element order is
 *  not semantic). All other arrays keep their order (semantically ordered). */
const TOP_LEVEL_ENTITY_ARRAYS = new Set([
  "rooms", "exits", "characters", "items", "loot", "materialCaches",
]);

function sortKeys(value: unknown, keyHint?: string): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((v) => sortKeys(v));
    if (keyHint === "equippedNames") {
      // `equippedNames` is an unordered display set: Rust emits it in equipment
      // BTreeMap slot-key order, the TS oracle in `Map` insertion (equip-call)
      // order. Sort both sides so the diff is order-insensitive — the same
      // "element order is not semantic" treatment as the id-keyed entity arrays
      // below. (Sub-plan 3b plan, Task 7 Step 3.)
      return [...(mapped as string[])].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
    }
    if (keyHint && TOP_LEVEL_ENTITY_ARRAYS.has(keyHint)) {
      return [...mapped].sort((a, b) => {
        const ai = (a as { id?: string }).id ?? "";
        const bi = (b as { id?: string }).id ?? "";
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k], k);
    }
    return out;
  }
  return value;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Like `canonical` but returns the sorted value rather than a JSON string.
 *  Use with vitest's `.toEqual()` for per-field deep comparison. */
export function canonicalize(value: unknown): unknown {
  return sortKeys(value);
}
