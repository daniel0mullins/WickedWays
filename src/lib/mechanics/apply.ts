import type { Campaign } from "../campaign.js";
import { EffectKind, type Effect } from "./mechanic.js";
import { StatType } from "../character/stats.js";
import { Status } from "../status.js";
import { ADJUST_STAT, FIND_CHARACTER, FIND_ANY_CHARACTER } from "./symbols.js";
import { GRANT_IMMUNITY, SET_VISIBLE } from "../inventory.js";
import { EMIT_CUE } from "../presentation.js";
import { ProceduralViolation } from "../util.js";

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
    case EffectKind.Status:
      campaign[EMIT_CUE]({ kind: "status", fields: e.fields });
      break;
    case EffectKind.GiveItem: {
      // Not party-restricted: resolve both endpoints as ANY character (NPCs/mobs
      // included). Route by which of `from`'s two lists holds the id — a key
      // moves keyring→keyring, a non-key inventory→inventory — leaving the item
      // object itself intact (only its holder changes; reachability follows).
      const from = campaign[FIND_ANY_CHARACTER](e.from);
      const item =
        from && [...from.inventory.items, ...from.inventory.keys].find((it) => it.id === e.item);
      // Carrying guard: `from` must actually hold the item (mirrors Rust's throw;
      // message is not gate-observable — a violation aborts replay before compare).
      if (!from || !item) {
        throw new ProceduralViolation(`Cannot give item '${e.item}': the character does not hold it.`);
      }
      // Recipient must exist before the id leaves `from`.
      const to = campaign[FIND_ANY_CHARACTER](e.to);
      if (!to) {
        throw new ProceduralViolation(`Give-item recipient '${e.to}' not found.`);
      }
      from.relinquishItem(item); // pull from whichever list holds it
      to.receiveItem(item); // push into the type-matching list + re-home holder
      break;
    }
    case EffectKind.SetVisible: {
      // Direct, reversible field set on any character; a missing target is a no-op.
      campaign[FIND_ANY_CHARACTER](e.target)?.[SET_VISIBLE](e.visible);
      break;
    }
  }
}
