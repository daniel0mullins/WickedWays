/** Gated reader: returns the entity's plain-data snapshot. */
export const SERIALIZE = Symbol("serialize");
/** Gated writer: applies snapshot data + wires references (two-pass-safe). */
export const HYDRATE = Symbol("hydrate");
/** Codex-only: inject an already-built, frozen CodexEntry directly. */
export const HYDRATE_CODEX = Symbol("hydrateCodex");
/**
 * Campaign-only: restore the archetype + recipe catalog. Called in PASS 1
 * (before any character hydrates) so `PlayerCharacter.hydrateExtra` can resolve
 * `campaign.archetypes.get(...)` against a populated catalog.
 */
export const HYDRATE_CATALOG = Symbol("hydrateCatalog");
/**
 * Campaign-only: inject the snapshot's codex entries into the private codex.
 * Threaded separately because the entries live on the full snapshot, not on the
 * campaign-core snapshot the main `[HYDRATE]` receives.
 */
export const HYDRATE_CODEX_ENTRIES = Symbol("hydrateCodexEntries");
