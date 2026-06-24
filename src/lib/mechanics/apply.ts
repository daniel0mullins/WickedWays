import type { Campaign } from "../campaign.js";
import { EffectKind, type Effect } from "./mechanic.js";
import { StatType } from "../character/stats.js";
import { Status } from "../status.js";
import { ADJUST_STAT, FIND_CHARACTER } from "./symbols.js";
import { GRANT_IMMUNITY } from "../inventory.js";
import { EMIT_CUE } from "../presentation.js";

const ALL_STATUSES: Status[] = Object.values(Status);

/**
 * Realize one effect against the live campaign — the single chokepoint where a
 * mechanic's intent becomes state. Routes through symbol seams; clamps every
 * magnitude (lower-floored at 0). Guardrail A.
 */
export function applyEffect(campaign: Campaign, e: Effect): void {
  switch (e.kind) {
    case EffectKind.Damage:
      campaign[FIND_CHARACTER](e.target)[ADJUST_STAT](StatType.Health, -Math.max(0, e.amount));
      break;
    case EffectKind.Heal:
      campaign[FIND_CHARACTER](e.target)[ADJUST_STAT](StatType.Health, Math.max(0, e.amount));
      break;
    case EffectKind.AdjustStat: {
      const stat = e.stat === StatType.Sanity ? StatType.Sanity : StatType.Energy;
      // delta sign is the mechanic's intent; intentionally not magnitude-clamped (unlike every other arm).
      campaign[FIND_CHARACTER](e.target)[ADJUST_STAT](stat, e.delta);
      break;
    }
    case EffectKind.GrantImmunity:
      campaign[FIND_CHARACTER](e.target)[GRANT_IMMUNITY](ALL_STATUSES, Math.max(0, Math.trunc(e.turns)));
      break;
    case EffectKind.Cue:
      campaign[EMIT_CUE]({ kind: "mechanic", cue: e.cue });
      break;
  }
}
