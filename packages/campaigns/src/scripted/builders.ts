/**
 * Typed builder helpers for the scripted-ops DSL. Each helper emits the exact
 * serde JSON of the Rust AST (`crates/wickedways-core/src/script/ast.rs`); the
 * types are the ts-rs-generated bindings, so authoring and interpretation share
 * one source of truth. See docs/superpowers/specs/2026-07-06-rust-engine-scripted-ops-dsl-design.md.
 */
import type { Expr } from "../../../../generated/bindings/Expr.ts";
import type { Stmt } from "../../../../generated/bindings/Stmt.ts";
import type { EffectTemplate } from "../../../../generated/bindings/EffectTemplate.ts";
import type { FieldTemplate } from "../../../../generated/bindings/FieldTemplate.ts";
import type { MechanicHooks } from "../../../../generated/bindings/MechanicHooks.ts";
import type { BehaviorScript } from "../../../../generated/bindings/BehaviorScript.ts";
import type { ItemScript } from "../../../../generated/bindings/ItemScript.ts";
import type { SceneScript } from "../../../../generated/bindings/SceneScript.ts";
import type { DialogueEntry } from "../../../../generated/bindings/DialogueEntry.ts";
import type { DialogueMatch } from "../../../../generated/bindings/DialogueMatch.ts";
import type { ScriptValue } from "../../../../generated/bindings/ScriptValue.ts";
import type { StatType } from "../../../../generated/bindings/StatType.ts";
import type { BinOp } from "../../../../generated/bindings/BinOp.ts";

export type { BehaviorScript, Expr, Stmt, EffectTemplate, FieldTemplate, DialogueEntry, DialogueMatch };

// ── expressions ───────────────────────────────────────────────────────────────
export const lit = (value: string | number | boolean | null): Expr => ({ kind: "lit", value });
export const mapLit = (entries: Record<string, ScriptValue>): Expr => ({ kind: "mapLit", entries });
export const round: Expr = { kind: "round" };
export const maxRounds: Expr = { kind: "maxRounds" };
export const party: Expr = { kind: "party" };
export const actor: Expr = { kind: "actor" };
export const action: Expr = { kind: "action" };
export const damageSubject: Expr = { kind: "damage" };
export const element: Expr = { kind: "element" };
export const first = (list: Expr): Expr => ({ kind: "first", list });
export const length = (list: Expr): Expr => ({ kind: "length", list });
export const index = (list: Expr, i: Expr): Expr => ({ kind: "index", list, index: i });
export const includes = (list: Expr, value: Expr): Expr => ({ kind: "includes", list, value });
export const get = (of: Expr, field: string): Expr => ({ kind: "get", of, field });
export const hasEquipped = (of: Expr, itemKey: string): Expr => ({ kind: "hasEquipped", of, itemKey });
export const hasItem = (of: Expr, itemKey: string): Expr => ({ kind: "hasItem", of, itemKey });
export const hasKey = (of: Expr, keyCode: string): Expr => ({ kind: "hasKey", of, keyCode });

const bin = (op: BinOp) => (left: Expr, right: Expr): Expr => ({ kind: "bin", op, left, right });
export const add = bin("add"); export const sub = bin("sub");
export const mul = bin("mul"); export const div = bin("div");
export const eq = bin("eq"); export const ne = bin("ne");
export const lt = bin("lt"); export const lte = bin("lte");
export const gt = bin("gt"); export const gte = bin("gte");
export const and = bin("and"); export const or = bin("or");
export const not = (expr: Expr): Expr => ({ kind: "not", expr });
export const ifElse = (cond: Expr, then: Expr, els: Expr): Expr => ({ kind: "ifElse", cond, then, else: els });
export const defined = (expr: Expr): Expr => ({ kind: "defined", expr });

export const stateGet = (field: string, def: ScriptValue): Expr =>
  ({ kind: "stateGet", field, default: def });
export const stateGetIn = (mapField: string, key: Expr, def: ScriptValue): Expr =>
  ({ kind: "stateGetIn", mapField, key, default: def });
export const lookup = (map: Expr, key: Expr): Expr => ({ kind: "lookup", map, key });
export const has = (map: Expr, key: Expr): Expr => ({ kind: "has", map, key });

export const some = (list: Expr, pred: Expr): Expr => ({ kind: "some", list, pred });
export const every = (list: Expr, pred: Expr): Expr => ({ kind: "every", list, pred });
export const str = (num: Expr): Expr => ({ kind: "str", num });
export const concat = (...parts: Expr[]): Expr => ({ kind: "concat", parts });

// ── statements ────────────────────────────────────────────────────────────────
export const guard = (cond: Expr): Stmt => ({ kind: "guard", cond });
export const when = (cond: Expr, then: Stmt[]): Stmt => ({ kind: "when", cond, then });
export const setState = (field: string, value: Expr): Stmt => ({ kind: "setState", field, value });
export const setStateIn = (mapField: string, key: Expr, value: Expr): Stmt =>
  ({ kind: "setStateIn", mapField, key, value });
export const emit = (effect: EffectTemplate): Stmt => ({ kind: "emit", effect });
export const pass = (value: Expr): Stmt => ({ kind: "pass", value });
/** Readability helper: a statement body is just an array. */
export const sequence = (...stmts: Stmt[]): Stmt[] => stmts;

// ── effect templates ──────────────────────────────────────────────────────────
export const damage = (target: Expr, amount: Expr): EffectTemplate =>
  ({ kind: "damage", target, amount });
export const heal = (target: Expr, amount: Expr): EffectTemplate =>
  ({ kind: "heal", target, amount });
export const adjust = (target: Expr, stat: StatType, delta: Expr): EffectTemplate =>
  ({ kind: "adjustStat", target, stat, delta });
export const grantImmunity = (target: Expr, turns: Expr): EffectTemplate =>
  ({ kind: "grantImmunity", target, turns });
export const cue = (text: Expr): EffectTemplate => ({ kind: "cue", text });
export const status = (fields: FieldTemplate[]): EffectTemplate => ({ kind: "status", fields });
export const field = (label: string, value: Expr, emphasis?: Expr): FieldTemplate =>
  emphasis === undefined ? { label, value } : { label, value, emphasis };

// ── behavior families ─────────────────────────────────────────────────────────
export const mechanic = (def: {
  init: unknown;
  hooks?: MechanicHooks;
  actions?: Record<string, Stmt[]>;
}): BehaviorScript => ({
  family: "mechanic",
  script: { init: def.init, hooks: def.hooks ?? {}, actions: def.actions ?? {} },
});

export const exit = (def: {
  canPass: Expr;
  runScript?: Stmt[];
  passMessage?: string;
  failMessage?: string;
}): BehaviorScript => ({
  family: "exit",
  script: {
    canPass: def.canPass,
    runScript: def.runScript ?? [],
    ...(def.passMessage !== undefined ? { passMessage: def.passMessage } : {}),
    ...(def.failMessage !== undefined ? { failMessage: def.failMessage } : {}),
  },
});

export const victory = (test: Expr): BehaviorScript => ({
  family: "victory",
  script: { test },
});

/**
 * `item`-family behavior: scripts an item's `use` / `read` side effects.
 *
 * - `onUse` fires **after** the usable/KO guards and **before** `grantsImmunity`
 *   is applied and the item is consumed — so it observes the pre-consume state
 *   and its effects land ahead of immunity/consumption.
 * - `onRead` fires **before** the item's `lore` cue, matching the free,
 *   non-consuming `Character.read` path.
 *
 * An unset hook is a no-op, so an item can script one path and leave the other
 * native. The hand-written item descriptor (`use` / `read` closure) stays the
 * differential-conformance oracle; the script must reproduce it byte-for-byte.
 */
export const item = (spec: {
  onUse?: Stmt[];
  onRead?: Stmt[];
}): BehaviorScript => {
  const script: ItemScript = {};
  if (spec.onUse !== undefined) script.onUse = spec.onUse;
  if (spec.onRead !== undefined) script.onRead = spec.onRead;
  return { family: "item", script };
};

/**
 * `scene`-family behavior (`BehaviorScript::Scene`): a scripted room scene. An
 * optional `canPlay` predicate `Expr` gates whether the scene may fire; optional
 * `onEnter` / `onExit` effect bodies (`Vec<Stmt>`) run on the matching phase (a
 * room registers a scene entry per phase, both keyed to this behavior). An unset
 * hook is a no-op. `canPlay` is ALWAYS serialized (mirroring the Rust `SceneScript`
 * serde shape — `#[serde(default)]`, not skip-if-none): `null` means always
 * playable. The hand-written `SceneBehavior` registry descriptor
 * (`preconditions` + `script`) stays the differential-conformance oracle; this
 * script must reproduce it byte-for-byte.
 */
export const scene = (def: {
  canPlay?: Expr;
  onEnter?: Stmt[];
  onExit?: Stmt[];
}): BehaviorScript => {
  const script: SceneScript = { canPlay: def.canPlay ?? null };
  if (def.onEnter !== undefined) script.onEnter = def.onEnter;
  if (def.onExit !== undefined) script.onExit = def.onExit;
  return { family: "scene", script };
};

// ── npc dialogue ────────────────────────────────────────────────────────────────
/** `Exact` match rule: full lowercased-string equality (`DialogueMatch::Exact`). */
export const exact = (text: string): DialogueMatch => ({ kind: "exact", text });
/** `Fuzzy` match rule: a token-subset trigger (`DialogueMatch::Fuzzy`). */
export const fuzzy = (...tokens: string[]): DialogueMatch => ({ kind: "fuzzy", tokens });

/** One prompt→response dialogue entry (`DialogueEntry`). `response` is a DSL Expr. */
export const entry = (def: {
  match: DialogueMatch;
  response: Expr;
  effects?: EffectTemplate[];
  once?: boolean;
}): DialogueEntry => ({
  match: def.match,
  response: def.response,
  effects: def.effects ?? [],
  once: def.once ?? false,
});

/**
 * `npc`-family behavior (`BehaviorScript::Npc`): an NPC's `examine` description,
 * a `default` dialogue entry (bare `talk`), and ordered prompt→response entries.
 */
export const npc = (def: {
  description: string;
  default: DialogueEntry;
  dialogue?: DialogueEntry[];
}): BehaviorScript => ({
  family: "npc",
  script: {
    description: def.description,
    default: def.default,
    dialogue: def.dialogue ?? [],
  },
});
