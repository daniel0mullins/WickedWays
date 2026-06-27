import { describe, it, expect } from "vitest";
import { EffectKind } from "wickedways/lib/mechanics/mechanic";
import { statusBar } from "./status.js";

function ctx(sanity: number, round: number) {
  return {
    state: {},
    rng: () => 0.5,
    roll: () => 1,
    view: { round, maxRounds: 150, party: [], rooms: [] },
    actor: { id: "pc", name: "Heir", health: 12, sanity, energy: 5, status: [], roomId: "R",
      hasEquipped: () => false, hasItem: () => false },
  } as never;
}

describe("statusBar mechanic", () => {
  it("emits a status effect with Sanity + Round fields, escalating emphasis", () => {
    const effects = statusBar.onTurnEnd!(ctx(2, 37)) ?? [];
    expect(effects).toEqual([
      { kind: EffectKind.Status, fields: [
        { label: "Sanity", value: "2", emphasis: "critical" },
        { label: "Round", value: "37/150" },
      ] },
    ]);
  });

  it("warns in the mid band and stays normal when healthy", () => {
    const warn = statusBar.onTurnEnd!(ctx(5, 1)) ?? [];
    expect((warn[0] as unknown as { fields: { emphasis?: string }[] }).fields[0]!.emphasis).toBe("warn");
    const ok = statusBar.onTurnEnd!(ctx(12, 1)) ?? [];
    expect((ok[0] as unknown as { fields: { emphasis?: string }[] }).fields[0]!.emphasis).toBe("normal");
  });
});
