/**
 * The `conformance:dread` mechanic — a TS "shadow" reproducing the Rust
 * `conformance::DREAD` op byte-for-byte
 * (crates/wickedways-core/src/world/mechanics/conformance.rs):
 * same cue texts, same effect ORDER in onRoundEnd (AdjustStat BEFORE Cue),
 * same integer damage cap (3, so both sides render "3"), and the same `brace`
 * custom action (Cue BEFORE AdjustStat sanity +1 on the bracing actor).
 *
 * Shared by every mechanics conformance generator (mechanics, mechanics-turnend,
 * mechanics-action) so the shadow cannot drift between fixtures.
 */
import type { Effect, Mechanic } from "wickedways/lib/mechanics/mechanic";

export const DREAD_KEY = "conformance:dread";

export const dreadShadow: Mechanic<{ ticks: number }, void, "brace"> = {
  initialState: () => ({ ticks: 0 }),
  onRoundStart: () => [{ kind: "cue", cue: { text: "Dread stirs." } }],
  onTurnStart: () => [{ kind: "cue", cue: { text: "The dread watches." } }],
  onTurnEnd: () => [{ kind: "cue", cue: { text: "The dread recedes." } }],
  onAction: () => [{ kind: "cue", cue: { text: "The dread notices." } }],
  onRoundEnd: (h) => {
    h.state.ticks += 1;
    const target = h.view.party[0]?.id;
    const effects: Effect[] = [];
    if (target !== undefined) {
      effects.push({ kind: "adjustStat", target, stat: "sanity", delta: -1 });
    }
    effects.push({ kind: "cue", cue: { text: "Dread deepens." } });
    return effects;
  },
  modifyDamage: (d) => (d.amount > 3 ? { value: 3, final: true } : d.amount),
  actions: {
    brace: {
      run: (h) => [
        { kind: "cue", cue: { text: "You brace against the dread." } },
        { kind: "adjustStat", target: h.actor.id, stat: "sanity", delta: 1 },
      ],
    },
  },
};
