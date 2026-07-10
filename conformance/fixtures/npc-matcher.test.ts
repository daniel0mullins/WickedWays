/**
 * Unit tests for the ORACLE dialogue matcher (`npc-matcher.ts`) — mirrors the
 * Rust `ScriptedNpc` test cases (`crates/wickedways-core/src/script/ops.rs`) so a
 * divergence surfaces here before Task 4's differential gate. Every case here has
 * a Rust twin; TRAP #1 (empty-trigger filter) and the vacuous-empty catch-all are
 * exercised explicitly.
 */
import { describe, it, expect } from "vitest";
import { EffectKind } from "wickedways/lib/mechanics/mechanic";
import {
  runTalk,
  description,
  type DialogueEntry,
  type DialogueMatch,
  type Expr,
  type NpcScript,
  type NpcState,
} from "./npc-matcher.ts";

const ACTOR = "pc";

const lit = (s: string): Expr => ({ kind: "lit", value: s });
const litNum = (n: number): Expr => ({ kind: "lit", value: n });

function entry(m: DialogueMatch, resp: string): DialogueEntry {
  return { match: m, response: lit(resp), effects: [], once: false };
}
const exact = (text: string, resp: string): DialogueEntry =>
  entry({ kind: "exact", text }, resp);
const fuzzy = (tokens: string[], resp: string): DialogueEntry =>
  entry({ kind: "fuzzy", tokens }, resp);

function npc(dialogue: DialogueEntry[]): NpcScript {
  return { description: "an npc", default: exact("", "DEFAULT"), dialogue };
}

/** Run talk and return the response cue text. */
function talkText(script: NpcScript, prompt: string | undefined, state: NpcState = null): string {
  return runTalk(script, prompt, state, ACTOR).cue.text;
}

describe("npc dialogue matcher — selection", () => {
  it("description returns the script description", () => {
    expect(description(npc([]))).toBe("an npc");
  });

  it("exact match is case/punct/edge-ws insensitive", () => {
    const script = npc([exact("hello there", "GREET")]);
    expect(talkText(script, "  Hello,   there!  ")).toBe("GREET");
  });

  it("exact requires the full phrase — an extra token is no match", () => {
    const script = npc([exact("hello there", "GREET")]);
    expect(talkText(script, "hello there friend")).toBe("DEFAULT");
  });

  it("exact beats fuzzy even when authored later", () => {
    const script = npc([fuzzy(["hello"], "FUZZY"), exact("hello there", "EXACT")]);
    expect(talkText(script, "hello there")).toBe("EXACT");
  });

  it("fuzzy subset matches reordered, with extra tokens and trailing punct", () => {
    const script = npc([fuzzy(["open", "door"], "FZ")]);
    expect(talkText(script, "please Door, OPEN now?")).toBe("FZ");
  });

  it("fuzzy missing a trigger token is no match", () => {
    const script = npc([fuzzy(["open", "door"], "FZ")]);
    expect(talkText(script, "open the window")).toBe("DEFAULT");
  });

  it("fuzzy highest score wins", () => {
    const script = npc([fuzzy(["cellar"], "ONE"), fuzzy(["cellar", "key"], "TWO")]);
    expect(talkText(script, "the cellar key")).toBe("TWO");
  });

  it("fuzzy score tie selects the first-authored entry", () => {
    const script = npc([fuzzy(["cellar"], "FIRST"), fuzzy(["key"], "SECOND")]);
    expect(talkText(script, "cellar key")).toBe("FIRST");
  });

  it("bare (undefined) prompt selects default", () => {
    const script = npc([fuzzy(["hello"], "FZ")]);
    expect(talkText(script, undefined)).toBe("DEFAULT");
  });

  it("all-punctuation prompt tokenizes empty and selects default", () => {
    const script = npc([fuzzy(["hello"], "FZ")]);
    expect(talkText(script, "!!! ???")).toBe("DEFAULT");
  });

  it("unmatched prompt selects default", () => {
    const script = npc([fuzzy(["xyz"], "FZ")]);
    expect(talkText(script, "hello world")).toBe("DEFAULT");
  });

  it("trailing '?' is stripped and an internal apostrophe is kept", () => {
    const script = npc([fuzzy(["cellar"], "C"), fuzzy(["don't"], "D")]);
    expect(talkText(script, "cellar?")).toBe("C");
    expect(talkText(script, "Don't go")).toBe("D");
  });
});

describe("npc dialogue matcher — TRAP #1 (empty-token filter) + vacuous catch-all", () => {
  it("fuzzy ['door','!!!'] MATCHES 'open the door' (empty trigger token filtered)", () => {
    // Naive `tokens.every(t => set.has(norm(t)))` would test set.has("") and FAIL;
    // the correct algorithm filters the emptied "!!!" before the subset test.
    const script = npc([fuzzy(["door", "!!!"], "FZ")]);
    expect(talkText(script, "open the door")).toBe("FZ");
  });

  it("fuzzy score counts only filtered/deduped tokens (not tokens.length)", () => {
    // ['door','!!!'] scores 1 (just 'door'); ['open','door'] scores 2 and wins.
    const script = npc([fuzzy(["door", "!!!"], "ONE"), fuzzy(["open", "door"], "TWO")]);
    expect(talkText(script, "open the door")).toBe("TWO");
  });

  it("an all-punctuation trigger is a score-0 catch-all (vacuous subset)", () => {
    // Empty trigger set ⊆ any prompt set → matches with score 0. A real fuzzy hit
    // (score ≥ 1) outscores it; when nothing else matches, the catch-all wins.
    const catchAll = fuzzy(["!!!"], "CATCH");
    const real = fuzzy(["cellar"], "REAL");
    expect(talkText(npc([catchAll, real]), "the cellar")).toBe("REAL");
    expect(talkText(npc([catchAll, real]), "the attic")).toBe("CATCH");
  });
});

describe("npc dialogue matcher — once latch + effects", () => {
  const giveEntry = (once: boolean): DialogueEntry => ({
    match: { kind: "fuzzy", tokens: ["give"] },
    response: lit("HERE"),
    effects: [{ kind: "adjustStat", target: { kind: "actor" }, stat: "sanity", delta: litNum(3) }],
    once,
  });

  it("once entry repeats its response but gates effects, persisting the latch", () => {
    const script = npc([giveEntry(true)]);

    // First talk fires the effect and returns the latch in nextState.
    const r1 = runTalk(script, "give", null, ACTOR);
    expect(r1.cue.text).toBe("HERE");
    expect(r1.effects).toHaveLength(1);
    expect(r1.effects[0]).toMatchObject({ kind: EffectKind.AdjustStat, target: ACTOR, stat: "sanity", delta: 3 });
    expect(r1.nextState).toEqual({ onceFired: { "0": true } });

    // Second talk (threading the latch) re-emits the response, suppresses effects,
    // and leaves the state unchanged.
    const r2 = runTalk(script, "give", r1.nextState, ACTOR);
    expect(r2.cue.text).toBe("HERE");
    expect(r2.effects).toHaveLength(0);
    expect(r2.nextState).toEqual({ onceFired: { "0": true } });
  });

  it("non-once entry re-emits effects on every call and never latches", () => {
    const script = npc([giveEntry(false)]);
    const r1 = runTalk(script, "give", null, ACTOR);
    expect(r1.effects).toHaveLength(1);
    expect(r1.nextState).toBeNull(); // no latch written → stays empty (null)
    const r2 = runTalk(script, "give", r1.nextState, ACTOR);
    expect(r2.effects).toHaveLength(1);
    expect(r2.nextState).toBeNull();
  });

  it("a once default entry latches under the 'default' key", () => {
    const dflt: DialogueEntry = {
      match: { kind: "exact", text: "" },
      response: lit("NODS"),
      effects: [{ kind: "adjustStat", target: { kind: "actor" }, stat: "sanity", delta: litNum(3) }],
      once: true,
    };
    const script: NpcScript = { description: "d", default: dflt, dialogue: [] };
    const r1 = runTalk(script, undefined, null, ACTOR);
    expect(r1.effects).toHaveLength(1);
    expect(r1.nextState).toEqual({ onceFired: { default: true } });
    const r2 = runTalk(script, undefined, r1.nextState, ACTOR);
    expect(r2.effects).toHaveLength(0);
  });
});
