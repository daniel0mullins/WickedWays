import type { Intent } from "../../../generated/bindings/Intent.ts";

export type { Intent };

/** Duplicated from the core's is_time_advancing for the HOST-side undo-stash
 *  decision only (the core classifies authoritatively inside submit). */
const TIME_ADVANCING = new Set<Intent["kind"]>([
  "move", "take", "drop", "use", "attack", "wait",
]);

export function isTimeAdvancing(intent: Intent): boolean {
  return TIME_ADVANCING.has(intent.kind);
}
