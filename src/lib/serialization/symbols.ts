/** Gated reader: returns the entity's plain-data snapshot. */
export const SERIALIZE = Symbol("serialize");
/** Gated writer: applies snapshot data + wires references (two-pass-safe). */
export const HYDRATE = Symbol("hydrate");
/** Codex-only: inject an already-built, frozen CodexEntry directly. */
export const HYDRATE_CODEX = Symbol("hydrateCodex");
