import { describe, it, expect } from "vitest";
import { dread, makeStoryteller } from "./mechanics.js";
import { EffectKind } from "wickedways/lib/mechanics/mechanic";
import { StatType } from "wickedways/lib/character/stats";
import { Items } from "./ids.js";

const actor = (over: Partial<{ id: string; equipped: string[]; items: string[] }> = {}) => ({
  id: "c1" as never,
  name: "Heir",
  health: 10, sanity: 10, energy: 10, status: [],
  roomId: "Cellar",
  hasEquipped: (k: string) => (over.equipped ?? []).includes(k),
  hasItem: (k: string) => (over.items ?? []).includes(k),
});
const ctx = (a: ReturnType<typeof actor>, action?: unknown) =>
  ({ actor: a, state: {}, action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 }) as never;

describe("dread", () => {
  it("drains 1 sanity when the lantern is not equipped", () => {
    const effects = dread.onTurnStart!(ctx(actor()));
    expect(effects).toEqual([{ kind: EffectKind.AdjustStat, target: "c1", stat: StatType.Sanity, delta: -1 }]);
  });
  it("does nothing when the lantern is equipped", () => {
    expect(dread.onTurnStart!(ctx(actor({ equipped: [Items.Lantern] })))).toEqual([]);
  });
});

describe("storyteller", () => {
  const lore = { Cellar: "The cellar reeks of old water." };
  it("emits the room's fragment once when holding the journal", () => {
    const m = makeStoryteller(lore);
    const state = m.initialState();
    const c = actor({ items: [Items.Journal] });
    const action = { kind: "move", room: { id: "r", name: "Cellar" } };
    const first = m.onAction!({ actor: c, state, action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 } as never);
    expect(first).toEqual([{ kind: EffectKind.Cue, cue: { text: "The cellar reeks of old water." } }]);
    const second = m.onAction!({ actor: c, state, action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 } as never);
    expect(second ?? []).toEqual([]);
  });
  it("stays silent without the journal", () => {
    const m = makeStoryteller(lore);
    const action = { kind: "move", room: { id: "r", name: "Cellar" } };
    const out = m.onAction!({ actor: actor(), state: m.initialState(), action, view: { round: 1, maxRounds: 150, party: [], rooms: [] }, rng: () => 0.5, roll: () => 1 } as never);
    expect(out ?? []).toEqual([]);
  });
});
