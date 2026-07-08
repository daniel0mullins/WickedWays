/**
 * ORACLE dialogue matcher (NPC sub-plan 2, Task 3b) — the pure-TS mirror of the
 * Rust `ScriptedNpc` matcher (`crates/wickedways-core/src/script/ops.rs`) and its
 * `run_talk`/`build_effect` path (`.../script/eval.rs`). This is oracle/test
 * infrastructure — NOT production `src/lib`. Task 4's fixture drives the
 * differential gate that proves this reproduces the Rust core byte-for-byte.
 *
 * ── Supported DSL subset (Route A) ─────────────────────────────────────────────
 * The `response` Expr and each `effects` EffectTemplate are evaluated by the small
 * evaluator below. Task 4's fixture MUST stay inside this subset:
 *
 *   Expr  = { kind:"lit"; value: string|number|boolean|null }   // literal
 *         | { kind:"actor" }                                     // the bound actor's id
 *
 *   EffectTemplate kinds (args are the Expr subset above):
 *     - adjustStat { target, stat:"sanity"|"energy", delta }
 *     - damage     { target, amount }
 *     - heal       { target, amount }
 *     - grantImmunity { target, turns }
 *     - cue        { text }
 *     - giveItem   { from, to, item }
 *     - setVisible { target, visible }
 *
 * Mirrors `build_effect`: `target`/`from`/`to` resolve to a character id (a string
 * literal or `actor`), `item` to an item id (string), numeric args to numbers, and
 * an unresolvable field DROPS just that effect (`filter_map(build_effect)`).
 *
 * ── ASCII ONLY ─────────────────────────────────────────────────────────────────
 * `String.prototype.toLowerCase()` and `\s` diverge from Rust `to_lowercase` /
 * `split_whitespace` on exotic Unicode. All prompts, triggers, and descriptions
 * authored for the oracle/fixture MUST be ASCII.
 */
import { EffectKind, type Effect, type JsonValue, type JsonObject } from "wickedways/lib/mechanics/mechanic";
import type { CharacterId } from "wickedways/lib/character/character";
import type { ItemId } from "wickedways/lib/inventory";

// ── DSL value + expression subset ──────────────────────────────────────────────
export type ScriptValue = string | number | boolean | null;
export type Expr = { kind: "lit"; value: ScriptValue } | { kind: "actor" };

export type DialogueMatch =
  | { kind: "exact"; text: string }
  | { kind: "fuzzy"; tokens: string[] };

export type EffectTemplate =
  | { kind: "adjustStat"; target: Expr; stat: "sanity" | "energy"; delta: Expr }
  | { kind: "damage"; target: Expr; amount: Expr }
  | { kind: "heal"; target: Expr; amount: Expr }
  | { kind: "grantImmunity"; target: Expr; turns: Expr }
  | { kind: "cue"; text: Expr }
  | { kind: "giveItem"; from: Expr; to: Expr; item: Expr }
  | { kind: "setVisible"; target: Expr; visible: Expr };

export interface DialogueEntry {
  match: DialogueMatch;
  response: Expr;
  effects?: EffectTemplate[];
  once?: boolean;
}

export interface NpcScript {
  description: string;
  default: DialogueEntry;
  dialogue?: DialogueEntry[];
}

/** Field the per-entry `once` latch lives under (Rust `LATCH_FIELD`). */
const LATCH_FIELD = "onceFired";

/**
 * Per-instance NPC dialogue state (the `once`-latch store). `null` when empty;
 * a fired latch is `{ onceFired: { <key>: true } }`. Typed as `JsonValue` so it
 * round-trips through the `Character[SET_NPC_STATE]` seam unchanged.
 */
export type NpcState = JsonValue;

// ── tokenize + normalize ────────────────────────────────────────────────────────

/** `char::is_ascii_punctuation()`: 0x21-2F, 0x3A-40, 0x5B-60, 0x7B-7E. */
function isAsciiPunct(cp: number): boolean {
  return (
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e)
  );
}

/** Trim ASCII-punctuation from BOTH edges only (Rust `trim_matches`). */
function stripEdges(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isAsciiPunct(s.charCodeAt(start))) start++;
  while (end > start && isAsciiPunct(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/**
 * Full normalize+tokenize (Rust `tokenize`): lowercase, split on whitespace, strip
 * ASCII-punctuation from both edges of each piece, drop emptied pieces. Order-
 * preserving, NOT deduped.
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const piece of s.toLowerCase().split(/\s+/)) {
    const t = stripEdges(piece);
    if (t.length > 0) out.push(t);
  }
  return out;
}

/** Atomic single-token normalize for a Fuzzy trigger (Rust `normalize_token`). */
function normalizeToken(t: string): string {
  return stripEdges(t.toLowerCase());
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isSubset(sub: ReadonlySet<string>, sup: ReadonlySet<string>): boolean {
  for (const x of sub) if (!sup.has(x)) return false;
  return true;
}

// ── selection ────────────────────────────────────────────────────────────────────

interface Selection {
  entry: DialogueEntry;
  /** Latch key: `"default"` for the default entry, else the decimal index. */
  key: string;
}

/**
 * Run the selection algorithm (Rust `select_entry`). Pure: depends only on the
 * script and the prompt.
 */
export function selectEntry(script: NpcScript, prompt: string | undefined | null): Selection {
  const defaultSel: Selection = { entry: script.default, key: "default" };
  const dialogue = script.dialogue ?? [];

  // 1. Bare prompt (undefined/null or empties to nothing) → default.
  if (prompt === undefined || prompt === null) return defaultSel;
  const ordered = tokenize(prompt);
  if (ordered.length === 0) return defaultSel;
  const promptSet = new Set(ordered);

  // 2a. First-authored matching Exact wins outright (Exact always beats Fuzzy).
  for (let i = 0; i < dialogue.length; i++) {
    const entry = dialogue[i]!;
    if (entry.match.kind === "exact" && arraysEqual(tokenize(entry.match.text), ordered)) {
      return { entry, key: String(i) };
    }
  }

  // 2b. Highest-score matching Fuzzy; first-authored breaks a score tie (strict >).
  let best: { score: number; entry: DialogueEntry; index: number } | null = null;
  for (let i = 0; i < dialogue.length; i++) {
    const entry = dialogue[i]!;
    if (entry.match.kind !== "fuzzy") continue;
    // TRAP #1: filter empty normalized trigger tokens BEFORE the subset test, and
    // dedup; score = the filtered/deduped count (NOT tokens.length). An empty /
    // all-punctuation trigger → empty set → vacuous subset match with score 0
    // (a deliberate catch-all mirroring JS `[].every()===true`).
    const trigger = new Set<string>();
    for (const tok of entry.match.tokens) {
      const n = normalizeToken(tok);
      if (n.length > 0) trigger.add(n);
    }
    if (isSubset(trigger, promptSet)) {
      const score = trigger.size;
      if (best === null || score > best.score) best = { score, entry, index: i };
    }
  }
  return best === null ? defaultSel : { entry: best.entry, key: String(best.index) };
}

// ── expression + effect evaluation (Route A subset) ───────────────────────────────

/** JS `String()` coercion over the supported value subset (Rust `coerce_str`). */
function coerceStr(v: ScriptValue): string {
  return typeof v === "string" ? v : String(v);
}

function evalExpr(e: Expr, actorId: string): ScriptValue {
  switch (e.kind) {
    case "lit":
      return e.value;
    case "actor":
      return actorId;
  }
}

/** Rust `as_character_id`: a string id (or the actor's id string). */
function asCharacterId(v: ScriptValue): CharacterId | undefined {
  return typeof v === "string" ? (v as CharacterId) : undefined;
}
/** Rust `as_item_id`: a string id. */
function asItemId(v: ScriptValue): ItemId | undefined {
  return typeof v === "string" ? (v as ItemId) : undefined;
}
/** Rust `as_number`. */
function asNumber(v: ScriptValue): number | undefined {
  return typeof v === "number" ? v : undefined;
}
/** JS `ToBoolean` — matches Rust `Value::truthy` for the primitive subset. */
function truthy(v: ScriptValue): boolean {
  return !!v;
}

/** Build one closed Effect from a template; `undefined` drops that emit (Rust `build_effect`). */
function buildEffect(t: EffectTemplate, actorId: string): Effect | undefined {
  switch (t.kind) {
    case "adjustStat": {
      const target = asCharacterId(evalExpr(t.target, actorId));
      const delta = asNumber(evalExpr(t.delta, actorId));
      if (target === undefined || delta === undefined) return undefined;
      return { kind: EffectKind.AdjustStat, target, stat: t.stat, delta };
    }
    case "damage": {
      const target = asCharacterId(evalExpr(t.target, actorId));
      const amount = asNumber(evalExpr(t.amount, actorId));
      if (target === undefined || amount === undefined) return undefined;
      return { kind: EffectKind.Damage, target, amount };
    }
    case "heal": {
      const target = asCharacterId(evalExpr(t.target, actorId));
      const amount = asNumber(evalExpr(t.amount, actorId));
      if (target === undefined || amount === undefined) return undefined;
      return { kind: EffectKind.Heal, target, amount };
    }
    case "grantImmunity": {
      const target = asCharacterId(evalExpr(t.target, actorId));
      const turns = asNumber(evalExpr(t.turns, actorId));
      if (target === undefined || turns === undefined) return undefined;
      return { kind: EffectKind.GrantImmunity, target, turns };
    }
    case "cue":
      return { kind: EffectKind.Cue, cue: { text: coerceStr(evalExpr(t.text, actorId)) } };
    case "giveItem": {
      const from = asCharacterId(evalExpr(t.from, actorId));
      const to = asCharacterId(evalExpr(t.to, actorId));
      const item = asItemId(evalExpr(t.item, actorId));
      if (from === undefined || to === undefined || item === undefined) return undefined;
      return { kind: EffectKind.GiveItem, from, to, item };
    }
    case "setVisible": {
      const target = asCharacterId(evalExpr(t.target, actorId));
      if (target === undefined) return undefined;
      return { kind: EffectKind.SetVisible, target, visible: truthy(evalExpr(t.visible, actorId)) };
    }
  }
}

function buildEffects(templates: readonly EffectTemplate[], actorId: string): Effect[] {
  const out: Effect[] = [];
  for (const t of templates) {
    const e = buildEffect(t, actorId);
    if (e !== undefined) out.push(e);
  }
  return out;
}

/** Whether `v` is a plain JSON object (not null, not an array). */
function isJsonObject(v: JsonValue): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `state[onceFired][key] = true`, auto-vivifying the map (Rust `state_set_in`). */
function setLatch(state: NpcState, key: string): JsonObject {
  const base: JsonObject = isJsonObject(state) ? { ...state } : {};
  const existing = base[LATCH_FIELD];
  const onceFired: JsonObject = existing !== undefined && isJsonObject(existing) ? { ...existing } : {};
  onceFired[key] = true;
  base[LATCH_FIELD] = onceFired;
  return base;
}

// ── run_talk + description ───────────────────────────────────────────────────────

export interface TalkResult {
  /** The response cue text (ALWAYS emitted). */
  cue: { text: string };
  /** Effects to apply (honoring `once`). */
  effects: Effect[];
  /** The NPC's next dialogue state (unchanged unless a `once` latch fired). */
  nextState: NpcState;
}

/**
 * Match `prompt` to exactly one dialogue entry (or the default), evaluate its
 * `response` to a cue (ALWAYS emitted), and return its `effects` honoring `once`
 * against `npcState`. Pure — reads the latch BEFORE computing the next state
 * (mirrors Rust `ScriptedNpc::run_talk`). `prompt` undefined/null is a bare talk.
 */
export function runTalk(
  script: NpcScript,
  prompt: string | undefined | null,
  npcState: NpcState,
  actorId: string,
): TalkResult {
  const sel = selectEntry(script, prompt);

  // Read the latch BEFORE deciding the next state.
  const latchStore = isJsonObject(npcState) ? npcState[LATCH_FIELD] : undefined;
  const already = latchStore !== undefined && isJsonObject(latchStore) && latchStore[sel.key] === true;
  const once = sel.entry.once ?? false;

  const cue = { text: coerceStr(evalExpr(sel.entry.response, actorId)) };
  const effects = once && already ? [] : buildEffects(sel.entry.effects ?? [], actorId);
  // A `once` entry sets its latch the first time it fires (regardless of effect
  // count); everything else leaves the state untouched (keeps `null` as `null`).
  const nextState: NpcState = once && !already ? setLatch(npcState, sel.key) : npcState;

  return { cue, effects, nextState };
}

/** The NPC's `examine` blurb (Rust `ScriptedNpc::description`). */
export function description(script: NpcScript): string {
  return script.description;
}
