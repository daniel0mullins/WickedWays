import type { CharacterId } from "../character/character";
import type { StatType } from "../character/stats";
import type { Status } from "../status";
import type { AssetRef } from "../presentation";
import type { ActionDetail } from "../character/history";

/** Runaway backstop: max effects one mechanic may emit for a single event. */
export const MAX_EFFECTS_PER_EVENT = 64;

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** Read-only projection handed to hooks. No setters, no clock, no IO. */
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
}
export interface RoomView {
  readonly id: string;
  readonly name: string;
  readonly lit: boolean;
  readonly occupantIds: readonly CharacterId[];
}

export interface HookCtx<S extends JsonObject> {
  /** This mechanic's own state — a live reference; mutate in place. */
  state: S;
  readonly view: CampaignView;
  readonly rng: () => number;
  /** Integer in [1, n], drawn from the campaign rng. */
  roll(n: number): number;
}
export interface TurnCtx<S extends JsonObject> extends HookCtx<S> {
  readonly actor: CharacterView;
}
export interface ActionCtx<S extends JsonObject> extends TurnCtx<S> {
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

/** The closed set of state changes a mechanic may request (guardrail A). */
export type Effect =
  | { kind: "damage"; target: CharacterId; amount: number }
  | { kind: "heal"; target: CharacterId; amount: number }
  | { kind: "adjustStat"; target: CharacterId; stat: "sanity" | "energy"; delta: number }
  | { kind: "grantImmunity"; target: CharacterId; turns: number }
  | { kind: "cue"; cue: MechanicCue };

export interface CustomAction<S extends JsonObject> {
  /** Action-budget cost; defaults to 1. */
  readonly cost?: number;
  run(h: ActionCtx<S>): Effect[] | void;
}

export interface Mechanic<
  S extends JsonObject,
  Cfg = void,
  A extends string = never,
> {
  initialState(config: Cfg): S;
  onRoundStart?(h: HookCtx<S>): Effect[] | void;
  onRoundEnd?(h: HookCtx<S>): Effect[] | void;
  onTurnStart?(h: TurnCtx<S>): Effect[] | void;
  onTurnEnd?(h: TurnCtx<S>): Effect[] | void;
  onAction?(h: ActionCtx<S>): Effect[] | void;
  modifyDamage?(d: DamageView, h: HookCtx<S>): TransformResult;
  actions?: Record<A, CustomAction<S>>;
}

/** A registered mechanic paired with its live (mutable) state, in opt-in order. */
export interface LiveMechanic {
  readonly key: string;
  readonly mechanic: Mechanic<JsonObject, unknown, string>;
  state: JsonObject;
}
