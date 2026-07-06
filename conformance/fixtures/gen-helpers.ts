import type { Campaign } from "wickedways/lib/campaign";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

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
 * Project the full TS ViewModel to the exact Rust ViewModel subset for goldens:
 * drop top-level `exits`/`lockedDoors` (never emitted here), `status.locationName`,
 * and `room.image`. Extracted from the per-generator copies — the body was identical
 * across all of them; the only variation was how `aliases`/`opened` were supplied,
 * so these default to empty (matching the generators that hardcoded empties).
 */
export function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]> = {},
  opened: ReadonlySet<string> = new Set(),
) {
  const full = view(campaign, aliases, opened);

  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  const { locationName: _locName, ...statusRest } = full.status as { locationName?: unknown; [k: string]: unknown };

  return {
    room: roomRest,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: statusRest,
    outcome: full.outcome,
    finished: full.finished,
  };
}
