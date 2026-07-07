import { describe, expect, it } from "vitest";
import * as s from "./builders.ts";

describe("scripted-ops builders", () => {
  it("emits the exact serde AST JSON for expressions", () => {
    expect(s.lit(5)).toEqual({ kind: "lit", value: 5 });
    expect(s.not(s.hasEquipped(s.actor, "lantern"))).toEqual({
      kind: "not",
      expr: { kind: "hasEquipped", of: { kind: "actor" }, itemKey: "lantern" },
    });
    expect(s.eq(s.get(s.action, "kind"), s.lit("move"))).toEqual({
      kind: "bin", op: "eq",
      left: { kind: "get", of: { kind: "action" }, field: "kind" },
      right: { kind: "lit", value: "move" },
    });
    expect(s.stateGetIn("seen", s.lit("Parlor"), false)).toEqual({
      kind: "stateGetIn", mapField: "seen", key: { kind: "lit", value: "Parlor" }, default: false,
    });
    expect(s.some(s.party, s.lte(s.get(s.element, "sanity"), s.lit(0)))).toEqual({
      kind: "some", list: { kind: "party" },
      pred: { kind: "bin", op: "lte",
        left: { kind: "get", of: { kind: "element" }, field: "sanity" },
        right: { kind: "lit", value: 0 } },
    });
    expect(s.concat(s.str(s.round), s.lit("/"), s.str(s.maxRounds))).toEqual({
      kind: "concat", parts: [
        { kind: "str", num: { kind: "round" } },
        { kind: "lit", value: "/" },
        { kind: "str", num: { kind: "maxRounds" } },
      ],
    });
  });

  it("emits statements and effect templates", () => {
    expect(s.emit(s.adjust(s.actor, "sanity", s.lit(-1)))).toEqual({
      kind: "emit", effect: { kind: "adjustStat", target: { kind: "actor" },
        stat: "sanity", delta: { kind: "lit", value: -1 } },
    });
    expect(s.setStateIn("seen", s.lit("Parlor"), s.lit(true))).toEqual({
      kind: "setStateIn", mapField: "seen",
      key: { kind: "lit", value: "Parlor" }, value: { kind: "lit", value: true },
    });
    // FieldTemplate is a plain struct (NOT kind-tagged); emphasis omitted when absent
    expect(s.field("Round", s.lit("1/10"))).toEqual({
      label: "Round", value: { kind: "lit", value: "1/10" },
    });
    expect(s.field("Sanity", s.lit("7"), s.lit("normal"))).toEqual({
      label: "Sanity", value: { kind: "lit", value: "7" },
      emphasis: { kind: "lit", value: "normal" },
    });
  });

  it("emits behavior-script families", () => {
    expect(s.victory(s.lit(true))).toEqual({
      family: "victory", script: { test: { kind: "lit", value: true } },
    });
    expect(s.exit({ canPass: s.lit(true), failMessage: "locked" })).toEqual({
      family: "exit",
      script: { canPass: { kind: "lit", value: true }, runScript: [], failMessage: "locked" },
    });
    expect(s.mechanic({ init: {}, hooks: { onTurnStart: [s.guard(s.lit(true))] } })).toEqual({
      family: "mechanic",
      script: { init: {}, hooks: { onTurnStart: [{ kind: "guard", cond: { kind: "lit", value: true } }] }, actions: {} },
    });
  });
});
