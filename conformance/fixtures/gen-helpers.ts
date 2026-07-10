import type { Campaign } from "wickedways/lib/campaign";
import { view } from "./oracle-view.ts";

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

/**
 * Project the full TS ViewModel to the exact Rust ViewModel subset for goldens.
 * Phase 2: `exits`, `lockedDoors`, and `status.locationName` are now emitted by
 * the Rust view and are DIFFED; only `room.image` (presentation, never
 * serialized — host-overlay concern) is still dropped.
 */
export function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]> = {},
  opened: ReadonlySet<string> = new Set(),
) {
  const full = view(campaign, aliases, opened);
  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  return {
    room: roomRest,
    exits: full.exits,
    lockedDoors: full.lockedDoors,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: full.status,
    outcome: full.outcome,
    finished: full.finished,
  };
}
