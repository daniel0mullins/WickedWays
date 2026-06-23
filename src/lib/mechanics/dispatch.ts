import type { DamageView, Effect, HookCtx, JsonObject, LiveMechanic } from "./mechanic.js";
import { MAX_EFFECTS_PER_EVENT } from "./mechanic.js";
import { ProceduralViolation } from "../util.js";

/** Run every mechanic's reducer hook (opt-in order), collect ALL effects, then
 *  apply them in a single pass. Applying effects must not re-enter dispatch —
 *  guardrail D (no re-entrancy). Per-mechanic effect count is capped. */
export function runReducers(
  mechanics: readonly LiveMechanic[],
  hook: (m: LiveMechanic) => Effect[] | void,
  apply: (e: Effect) => void,
): void {
  const queued: Effect[] = [];
  for (const m of mechanics) {
    const out = hook(m) ?? [];
    if (out.length > MAX_EFFECTS_PER_EVENT) {
      throw new ProceduralViolation(
        `Mechanic '${m.key}' emitted ${out.length} effects (cap ${MAX_EFFECTS_PER_EVENT}).`,
      );
    }
    queued.push(...out);
  }
  for (const e of queued) apply(e);
}

/** Fold an incoming damage value through each mechanic's transformer (opt-in
 *  order), clamping at 0 after each. A `final` result locks the value, halts the
 *  chain, and signals `onFinal` (for the diagnostic cue). */
export function runDamageTransformers(
  mechanics: readonly LiveMechanic[],
  initial: DamageView,
  ctxFor: (m: LiveMechanic) => HookCtx<JsonObject>,
  onFinal: (key: string, value: number) => void,
): number {
  let value = initial.amount;
  for (const m of mechanics) {
    const fn = m.mechanic.modifyDamage;
    if (!fn) continue;
    const r = fn({ ...initial, amount: value }, ctxFor(m));
    const next = Math.max(0, typeof r === "number" ? r : r.value);
    if (typeof r === "object" && r.final) {
      onFinal(m.key, next);
      return next;
    }
    value = next;
  }
  return value;
}
