import type { CharacterId } from "../character/character";
import type { StatType } from "../character/stats";
import type { Status } from "../status";
import type { AssetRef, StatusField } from "../presentation";
import type { ActionDetail } from "../character/history";

/** Runaway backstop: max effects one mechanic may emit for a single event. */
export const MAX_EFFECTS_PER_EVENT = 64;

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/**
 * Read-only projection of campaign state handed to every hook.
 * Contains no engine handles, no clock, and no IO — all you need is here
 * (guardrail B: determinism).
 */
export interface CampaignView {
  readonly round: number;
  readonly maxRounds: number;
  readonly party: readonly CharacterView[];
  readonly rooms: readonly RoomView[];
}
export interface CharacterView {
  readonly id: CharacterId;
  readonly name: string;
  readonly health: number;
  readonly sanity: number;
  readonly energy: number;
  readonly status: readonly Status[];
  readonly roomId: string | undefined;
  /** True if an equipped item was registered under this registry key. */
  hasEquipped(itemKey: string): boolean;
  /** True if an item in the character's inventory has this registry key. */
  hasItem(itemKey: string): boolean;
}
export interface RoomView {
  readonly id: string;
  readonly name: string;
  readonly lit: boolean;
  readonly occupantIds: readonly CharacterId[];
}

/**
 * Context object passed to every reducer hook (`onRoundStart`, `onRoundEnd`,
 * `onTurnStart`, `onTurnEnd`, `onAction`) and to the `modifyDamage` transformer.
 *
 * The `state` field is the mechanic's own persistent `JsonObject`; mutate it in
 * place — mutations are preserved across the campaign (serialized by key as
 * `{ key, state }` in schema v5).
 *
 * All randomness must go through `rng` / `roll` so same-seed runs produce
 * identical results (guardrail B: determinism).
 */
export interface HookCtx<State extends JsonObject> {
  /** This mechanic's own state — a live reference; mutate in place. */
  state: State;
  readonly view: CampaignView;
  readonly rng: () => number;
  /** Integer in [1, n], drawn from the campaign rng. */
  roll(n: number): number;
}
/**
 * Hook context for turn-phase hooks (`onTurnStart`, `onTurnEnd`).
 * Extends {@link HookCtx} with the character whose turn is starting/ending.
 */
export interface TurnCtx<State extends JsonObject> extends HookCtx<State> {
  readonly actor: CharacterView;
}
/**
 * Hook context for the action hook (`onAction`).
 * Extends {@link TurnCtx} with the detail of the action that just occurred.
 */
export interface ActionCtx<State extends JsonObject> extends TurnCtx<State> {
  readonly action: ActionDetail;
}

export interface DamageView {
  readonly amount: number;
  readonly target: CharacterId;
  readonly stat: StatType;
  readonly source: CharacterId | undefined;
}
/** A transformer returns the adjusted amount, or locks it and halts the chain. */
export type TransformResult = number | { value: number; final: true };

export interface MechanicCue {
  readonly text?: string;
  readonly sound?: AssetRef;
}

/**
 * The closed set of state changes a mechanic may request (guardrail A — integrity).
 *
 * Effects are collected across all enabled mechanics for a given event and
 * applied in a single pass after all reducers have run (collect-then-apply).
 * Every magnitude is floored at 0 inside the applier; `adjustStat` passes the
 * signed delta through to the underlying `ADJUST_STAT` seam unchanged.
 *
 * - `damage` / `heal` — adjusts `Health` via `ADJUST_STAT`.
 * - `adjustStat` — adjusts `"sanity"` or `"energy"` by a signed delta.
 * - `grantImmunity` — grants all-status immunity for `turns` rounds (floored, truncated).
 * - `cue` — emits a `{ kind: "mechanic", cue }` {@link PresentationCue}.
 */
/** The discriminants of the {@link Effect} union. */
export const EffectKind = {
  Damage: "damage",
  Heal: "heal",
  AdjustStat: "adjustStat",
  GrantImmunity: "grantImmunity",
  Cue: "cue",
  Status: "status",
} as const;
/** One of the {@link EffectKind} values. */
export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind];

export type Effect =
  | { kind: typeof EffectKind.Damage; target: CharacterId; amount: number }
  | { kind: typeof EffectKind.Heal; target: CharacterId; amount: number }
  | { kind: typeof EffectKind.AdjustStat; target: CharacterId; stat: "sanity" | "energy"; delta: number }
  | { kind: typeof EffectKind.GrantImmunity; target: CharacterId; turns: number }
  | { kind: typeof EffectKind.Cue; cue: MechanicCue }
  | { kind: typeof EffectKind.Status; fields: readonly StatusField[] };

/**
 * A named action exposed by a mechanic and invoked via
 * `character.useMechanicAction(mechanicKey, actionKey)`.
 *
 * Custom actions are **budgeted**: each call ticks the character's per-round action
 * budget (registered by method identity alongside built-in budgeted actions).
 * `cost` is accepted and reserved for a future budget-multiplier enhancement; in v1
 * every custom action costs 1 regardless of `cost`.
 *
 * `run` receives an {@link ActionCtx} and may return `Effect[]` or `void`.
 */
export interface CustomAction<State extends JsonObject> {
  /** Action-budget cost; defaults to 1. (Reserved — v1 always uses cost 1.) */
  readonly cost?: number;
  run(h: ActionCtx<State>): Effect[] | void;
}

/**
 * A custom game mechanic that a campaign can opt into via `.useMechanic(key, config?)`.
 *
 * @typeParam State     - The mechanic's own persistent state, a {@link JsonObject} (serialized as-is).
 * @typeParam Config    - Configuration supplied at opt-in time; passed verbatim to `initialState`.
 *                        Resolves to `unknown` at the call site in v1 (type-safe config is deferred).
 * @typeParam ActionKey - The string union of custom action keys this mechanic exposes.
 *
 * **Purity contract** (guardrail B): hooks must be pure given their {@link HookCtx} inputs.
 * No global state, no ambient clock, no IO. All randomness via `h.rng` / `h.roll`.
 *
 * **State contract**: `State` must be a plain `JsonObject` so the engine can serialize it without
 * a custom replacer. Only `{ key, state }` is persisted; behavior re-binds from the registry
 * on hydrate.
 *
 * **Opt-in order is precedence**: the mechanic registered first runs its hooks first. A
 * `modifyDamage` that returns `{ value, final: true }` halts the transformer chain — no later
 * mechanic's `modifyDamage` will run.
 */
export interface Mechanic<
  State extends JsonObject,
  Config = void,
  ActionKey extends string = never,
> {
  initialState(config: Config): State;
  onRoundStart?(h: HookCtx<State>): Effect[] | void;
  onRoundEnd?(h: HookCtx<State>): Effect[] | void;
  onTurnStart?(h: TurnCtx<State>): Effect[] | void;
  onTurnEnd?(h: TurnCtx<State>): Effect[] | void;
  onAction?(h: ActionCtx<State>): Effect[] | void;
  modifyDamage?(d: DamageView, h: HookCtx<State>): TransformResult;
  actions?: Record<ActionKey, CustomAction<State>>;
}

/** A registered mechanic paired with its live (mutable) state, in opt-in order. */
export interface LiveMechanic {
  readonly key: string;
  readonly mechanic: Mechanic<JsonObject, unknown, string>;
  state: JsonObject;
}
