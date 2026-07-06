/**
 * Shared helpers for golden generators.
 *
 * `structuralClone` deep-copies a serialized value at capture time. `Exit` and
 * `Scene` `[SERIALIZE]` return their `state` by LIVE reference, so a later
 * command that mutates that state would retroactively corrupt the snapshots
 * recorded for earlier steps unless each capture is deep-copied.
 */
export function structuralClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
