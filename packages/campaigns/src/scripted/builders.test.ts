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
    // item family: onUse/onRead effect bodies; absent hooks omitted entirely.
    expect(s.item({ onUse: [s.emit(s.adjust(s.actor, "sanity", s.lit(6)))] })).toEqual({
      family: "item",
      script: {
        onUse: [{ kind: "emit", effect: { kind: "adjustStat", target: { kind: "actor" }, stat: "sanity", delta: { kind: "lit", value: 6 } } }],
      },
    });
    expect(s.item({})).toEqual({ family: "item", script: {} });
  });

  it("emits the scene family with canPlay + phase bodies", () => {
    // Full: a canPlay predicate + both phase bodies; canPlay serialized as its Expr.
    expect(
      s.scene({
        canPlay: s.lt(s.stateGet("count", 0), s.lit(2)),
        onEnter: [s.emit({ kind: "setVisible", target: s.lit("mob:Gargoyle"), visible: s.lit(false) })],
        onExit: [s.emit(s.cue(s.lit("The vault falls silent behind you.")))],
      }),
    ).toEqual({
      family: "scene",
      script: {
        canPlay: {
          kind: "bin", op: "lt",
          left: { kind: "stateGet", field: "count", default: 0 },
          right: { kind: "lit", value: 2 },
        },
        onEnter: [
          { kind: "emit", effect: { kind: "setVisible", target: { kind: "lit", value: "mob:Gargoyle" }, visible: { kind: "lit", value: false } } },
        ],
        onExit: [
          { kind: "emit", effect: { kind: "cue", text: { kind: "lit", value: "The vault falls silent behind you." } } },
        ],
      },
    });
    // canPlay omitted → null (always serialized); onEnter-only body, onExit omitted.
    expect(
      s.scene({ onEnter: [s.setState("seen", s.lit(true))] }),
    ).toEqual({
      family: "scene",
      script: {
        canPlay: null,
        onEnter: [{ kind: "setState", field: "seen", value: { kind: "lit", value: true } }],
      },
    });
  });

  it("emits npc dialogue match rules, entries, and the npc family", () => {
    // Match rules.
    expect(s.exact("hello")).toEqual({ kind: "exact", text: "hello" });
    expect(s.fuzzy("key", "cellar")).toEqual({ kind: "fuzzy", tokens: ["key", "cellar"] });
    // entry(): effects default to [] and once defaults to false when omitted.
    expect(s.entry({ match: s.exact("hi"), response: s.lit("Hello there.") })).toEqual({
      match: { kind: "exact", text: "hi" },
      response: { kind: "lit", value: "Hello there." },
      effects: [],
      once: false,
    });
    // entry(): explicit effects + once are threaded through.
    expect(
      s.entry({
        match: s.fuzzy("give", "key"),
        response: s.lit("Take it."),
        effects: [s.cue(s.lit("A key changes hands."))],
        once: true,
      }),
    ).toEqual({
      match: { kind: "fuzzy", tokens: ["give", "key"] },
      response: { kind: "lit", value: "Take it." },
      effects: [{ kind: "cue", text: { kind: "lit", value: "A key changes hands." } }],
      once: true,
    });
    // npc family: description + default entry + ordered dialogue; dialogue omitted → [].
    expect(
      s.npc({
        description: "A hooded figure.",
        default: s.entry({ match: s.exact(""), response: s.lit("...") }),
        dialogue: [s.entry({ match: s.exact("name"), response: s.lit("I am no one.") })],
      }),
    ).toEqual({
      family: "npc",
      script: {
        description: "A hooded figure.",
        default: {
          match: { kind: "exact", text: "" },
          response: { kind: "lit", value: "..." },
          effects: [],
          once: false,
        },
        dialogue: [
          {
            match: { kind: "exact", text: "name" },
            response: { kind: "lit", value: "I am no one." },
            effects: [],
            once: false,
          },
        ],
      },
    });
    expect(
      s.npc({ description: "Silent.", default: s.entry({ match: s.exact(""), response: s.lit("") }) }),
    ).toEqual({
      family: "npc",
      script: {
        description: "Silent.",
        default: { match: { kind: "exact", text: "" }, response: { kind: "lit", value: "" }, effects: [], once: false },
        dialogue: [],
      },
    });
  });
});
