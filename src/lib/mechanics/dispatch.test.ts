import { describe, it, expect } from "vitest";
import { runReducers, runDamageTransformers } from "./dispatch.js";
import { MAX_EFFECTS_PER_EVENT } from "./mechanic.js";
import type { LiveMechanic } from "./mechanic.js";

const live = (key: string, mechanic: object): LiveMechanic =>
  ({ key, mechanic: mechanic as never, state: {} });

describe("runReducers", () => {
  it("collects all effects, then applies once in opt-in order", () => {
    const applied: string[] = [];
    const ms = [
      live("a", { onRoundEnd: () => [{ kind: "cue", cue: { text: "a" } }] }),
      live("b", { onRoundEnd: () => [{ kind: "cue", cue: { text: "b" } }] }),
    ];
    runReducers(ms, (m) => m.mechanic.onRoundEnd?.({} as never), (e) =>
      applied.push(e.kind === "cue" ? (e.cue.text ?? "") : e.kind));
    expect(applied).toEqual(["a", "b"]);
  });

  it("throws when one mechanic exceeds the per-event cap", () => {
    const ms = [live("flood", {
      onRoundEnd: () => Array.from({ length: MAX_EFFECTS_PER_EVENT + 1 },
        () => ({ kind: "cue", cue: {} })),
    })];
    expect(() => runReducers(ms, (m) => m.mechanic.onRoundEnd?.({} as never), () => {}))
      .toThrow(/cap/);
  });
});

describe("runDamageTransformers", () => {
  const dv = { amount: 10, target: "t" as never, stat: 0 as never, source: undefined };
  const ctx = () => ({}) as never;

  it("chains transforms in opt-in order, clamping at 0", () => {
    const ms = [
      live("dbl", { modifyDamage: (d: { amount: number }) => d.amount * 2 }),
      live("sub", { modifyDamage: (d: { amount: number }) => d.amount - 100 }),
    ];
    expect(runDamageTransformers(ms, dv, ctx, () => {})).toBe(0); // (10*2)-100 -> clamp 0
  });

  it("`final` halts the chain, locks the value, and signals onFinal", () => {
    let finalKey = "";
    const ms = [
      live("ward", { modifyDamage: () => ({ value: 0, final: true }) }),
      live("dbl", { modifyDamage: (d: { amount: number }) => d.amount + 999 }),
    ];
    expect(runDamageTransformers(ms, dv, ctx, (k) => { finalKey = k; })).toBe(0);
    expect(finalKey).toBe("ward");
  });
});
