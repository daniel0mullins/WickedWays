import { EffectKind, type Mechanic, type JsonObject, type TurnCtx, type HookCtx } from "wickedways/lib/mechanics/mechanic";
import type { Effect } from "wickedways/lib/mechanics/mechanic";
import type { StatusField } from "wickedways/lib/presentation";

function emphasisFor(sanity: number): StatusField["emphasis"] {
  if (sanity <= 3) return "critical";
  if (sanity <= 6) return "warn";
  return "normal";
}

function fields(sanity: number, round: number, maxRounds: number): Effect[] {
  return [{
    kind: EffectKind.Status,
    fields: [
      { label: "Sanity", value: String(sanity), emphasis: emphasisFor(sanity) },
      { label: "Round", value: `${round}/${maxRounds}` },
    ],
  }];
}

/** Pushes a campaign-defined status readout (Sanity + Round) to the play surface. */
export const statusBar: Mechanic<JsonObject> = {
  initialState: () => ({}),
  // Initial paint at round start (party may be empty pre-boot → emit nothing).
  onRoundStart: (h: HookCtx<JsonObject>) => {
    const pc = h.view.party[0];
    return pc ? fields(pc.sanity, h.view.round, h.view.maxRounds) : [];
  },
  // After each turn's effects (e.g. dread), so values are current.
  onTurnEnd: (h: TurnCtx<JsonObject>) =>
    fields(h.actor.sanity, h.view.round, h.view.maxRounds),
};
