import { EffectKind, type Mechanic, type JsonObject } from "wickedways/lib/mechanics/mechanic";
import { StatType } from "wickedways/lib/character/stats";
import { Items } from "./ids.js";

export const dread: Mechanic<JsonObject> = {
  initialState: () => ({}),
  onTurnStart: (ctx) =>
    ctx.actor.hasEquipped(Items.Lantern)
      ? []
      : [{ kind: EffectKind.AdjustStat, target: ctx.actor.id, stat: StatType.Sanity, delta: -1 }],
};

export function makeStoryteller(lore: Record<string, string>): Mechanic<JsonObject> {
  return {
    initialState: () => ({ seen: {} }),
    onAction: (ctx) => {
      if (ctx.action.kind !== "move") return [];
      const roomName = ctx.action.room.name;
      const fragment = lore[roomName];
      if (fragment === undefined) return [];
      if (!ctx.actor.hasItem(Items.Journal)) return [];
      const seen = (ctx.state.seen ??= {}) as Record<string, boolean>;
      if (seen[roomName]) return [];
      seen[roomName] = true;
      return [{ kind: EffectKind.Cue, cue: { text: fragment } }];
    },
  };
}
