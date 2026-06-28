import type { ActionDetail } from "./character/history";
import type { CampaignOutcome, OutcomeNarration } from "./victory";
import type { MechanicCue } from "./mechanics/mechanic";

/** Host-interpreted reference to an asset (path, URL, or key). Opaque to the engine. */
export type AssetRef = string;

/** Optional presentation metadata attached to a renderable/audible entity. */
export interface Presentation {
  /** Image shown when the entity is rendered on the Play Surface. */
  image?: AssetRef;
  /** The entity's signature sound, used to resolve cue audio. */
  sound?: AssetRef;
}

/** Minimal identity for an entity referenced by a cue. */
export interface EntityRef {
  id: string;
  name: string;
}

/** One labelled readout in a campaign-defined status bar. */
export interface StatusField {
  /** The readout's label, e.g. `"Sanity"`. */
  label: string;
  /** The formatted value string, e.g. `"7"`. */
  value: string;
  /** Optional severity. `"warn"` and `"critical"` map to the active theme's palette; omitting or passing `"normal"` renders plainly. */
  emphasis?: "normal" | "warn" | "critical";
}

/** The action kinds an action cue can carry — kept in sync with {@link ActionDetail}. */
export type ActionKind = ActionDetail["kind"];

/**
 * A presentation event emitted by the campaign. `sound` is pre-resolved by the
 * engine (entity sound → campaign default → undefined); the host plays it if set.
 *
 * - `action` — a recorded player action (move, attack, take, …).
 * - `encounter` — the first time the player meets a given mob.
 * - `visibility` — a dark room's lit state changed (reveal/conceal).
 * - `resolution` — the campaign ended (win / loss / timeout).
 * - `mechanic` — a custom mechanic emitted a narration line.
 * - `status` — the campaign pushes a new status-bar readout (`StatusField[]`).
 *   The play surface renders the latest payload in its HUD; before the first
 *   emission the status area is empty. Campaigns without a status mechanic (e.g.
 *   the seed demo) simply never emit this cue.
 */
export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef }
  | { kind: "visibility"; room: EntityRef; lit: boolean }
  | { kind: "resolution"; outcome: CampaignOutcome; reason?: string; narration?: OutcomeNarration }
  | { kind: "mechanic"; cue: MechanicCue }
  | { kind: "status"; fields: readonly StatusField[] };

/**
 * Engine-internal seam for publishing a cue to the campaign's subscribers.
 * Subscription (`onCue`/`offCue`) is public; publication is gated so external
 * code cannot inject fake cues.
 */
export const EMIT_CUE = Symbol("emitCue");

/**
 * Engine-internal seam: scan a room a character just entered and emit a one-time
 * `encounter` cue per active mob the character has not encountered before.
 */
export const NOTE_ENCOUNTERS = Symbol("noteEncounters");
