import type { CharacterId, ICharacter } from "./character/character";
import type { IItem, MaterialMap } from "./inventory";
import type { IRoom, RoomId } from "./room";
import type { CraftingRecipe, KeyCost, RecipeId } from "./crafting";
import type { SlotKind } from "./equipment";
import type { Presentation } from "./presentation";
import { HYDRATE_CODEX } from "./serialization/symbols";

/**
 * Engine-internal seam for recording a party encounter into the campaign Codex.
 * Publication is gated so external/scene code cannot forge Codex entries; reads
 * are public via `campaign.codex`.
 */
export const RECORD_ENCOUNTER = Symbol("recordEncounter");

/** The distinct categories the Codex tracks. */
export type CodexKind = "mob" | "item" | "key" | "room" | "recipe" | "material";

/** When/where/by-whom an entry was first encountered. */
export interface CodexFirstSeen {
  readonly round: number;
  readonly characterId: CharacterId | undefined;
  readonly roomId: RoomId | undefined;
}

/** Frozen descriptive snapshot for a mob. The engine has no mob description field. */
export interface MobSnapshot {
  readonly name: string;
  readonly stats: { readonly health: number; readonly sanity: number; readonly energy: number };
  readonly presentation?: Presentation;
}

/** Frozen descriptive snapshot for a regular (non-key) inventory item. */
export interface ItemSnapshot {
  readonly name: string;
  readonly type: string;
  readonly slot?: SlotKind;
  readonly twoHanded?: boolean;
  readonly emitsLight?: boolean;
  readonly presentation?: Presentation;
}

/** Frozen descriptive snapshot for a keyring key. */
export interface KeySnapshot {
  readonly name: string;
  readonly keyCode: string;
  readonly consumeOnUse: boolean;
  readonly presentation?: Presentation;
}

/** Frozen descriptive snapshot for a room. */
export interface RoomSnapshot {
  readonly name: string;
  readonly description: string;
  readonly presentation?: Presentation;
}

/** Frozen descriptive snapshot for a crafting recipe. */
export interface RecipeSnapshot {
  readonly id: RecipeId;
  readonly materials?: MaterialMap;
  readonly keys?: readonly KeyCost[];
  readonly outputName: string;
  readonly outputPresentation?: Presentation;
}

/** Frozen descriptive snapshot for a material component type. */
export interface MaterialSnapshot {
  readonly type: keyof MaterialMap;
}

/** A single Codex entry: a synthetic grouping key, a snapshot, and a first-seen stamp. */
export type CodexEntry =
  | { readonly kind: "mob"; readonly key: string; readonly snapshot: MobSnapshot; readonly firstSeen: CodexFirstSeen }
  | { readonly kind: "item"; readonly key: string; readonly snapshot: ItemSnapshot; readonly firstSeen: CodexFirstSeen }
  | { readonly kind: "key"; readonly key: string; readonly snapshot: KeySnapshot; readonly firstSeen: CodexFirstSeen }
  | { readonly kind: "room"; readonly key: string; readonly snapshot: RoomSnapshot; readonly firstSeen: CodexFirstSeen }
  | { readonly kind: "recipe"; readonly key: string; readonly snapshot: RecipeSnapshot; readonly firstSeen: CodexFirstSeen }
  | { readonly kind: "material"; readonly key: string; readonly snapshot: MaterialSnapshot; readonly firstSeen: CodexFirstSeen };

/** A live-entity encounter to be recorded. The Codex extracts the snapshot. */
export type CodexEncounterEvent =
  | { kind: "mob"; mob: ICharacter }
  | { kind: "item"; item: IItem } // discriminated to "item" or "key" by item.type
  | { kind: "room"; room: IRoom }
  | { kind: "recipe"; recipe: CraftingRecipe }
  | { kind: "material"; material: keyof MaterialMap };

/** Read-only view of the Codex. `campaign.codex` returns this; writes are gated. */
export interface ICodex {
  get mobs(): readonly Extract<CodexEntry, { kind: "mob" }>[];
  get items(): readonly Extract<CodexEntry, { kind: "item" }>[];
  get keys(): readonly Extract<CodexEntry, { kind: "key" }>[];
  get rooms(): readonly Extract<CodexEntry, { kind: "room" }>[];
  get recipes(): readonly Extract<CodexEntry, { kind: "recipe" }>[];
  get materials(): readonly Extract<CodexEntry, { kind: "material" }>[];
  /** Every entry, in discovery order. */
  get all(): readonly CodexEntry[];
  /** Total number of distinct entries. */
  get size(): number;
  /** A single entry by kind + synthetic key, or `undefined`. */
  get(kind: CodexKind, key: string): CodexEntry | undefined;
}

/** Recursively freezes an object graph in place; primitives pass through. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The field used to sort entries of a kind for display. */
function displayName(entry: CodexEntry): string {
  return entry.kind === "recipe"
    ? entry.snapshot.outputName
    : entry.kind === "material"
      ? entry.snapshot.type
      : entry.snapshot.name;
}

/** Builds a fully-frozen entry from a live event and a first-seen stamp. */
function buildEntry(event: CodexEncounterEvent, firstSeen: CodexFirstSeen): CodexEntry {
  let entry: CodexEntry;
  switch (event.kind) {
    case "mob": {
      const m = event.mob;
      entry = {
        kind: "mob",
        key: m.name,
        snapshot: {
          name: m.name,
          stats: { health: m.stats.health, sanity: m.stats.sanity, energy: m.stats.energy },
          ...(m.presentation ? { presentation: { ...m.presentation } } : {}),
        },
        firstSeen,
      };
      break;
    }
    case "item": {
      const it = event.item;
      if (it.type === "key") {
        entry = {
          kind: "key",
          key: `${it.keyCode ?? ""}:${it.name}`,
          snapshot: {
            name: it.name,
            keyCode: it.keyCode ?? "",
            consumeOnUse: it.consumeOnUse ?? false,
            ...(it.presentation ? { presentation: { ...it.presentation } } : {}),
          },
          firstSeen,
        };
      } else {
        entry = {
          kind: "item",
          key: `${it.type}:${it.name}`,
          snapshot: {
            name: it.name,
            type: it.type,
            ...(it.slot !== undefined ? { slot: it.slot } : {}),
            ...(it.twoHanded !== undefined ? { twoHanded: it.twoHanded } : {}),
            ...(it.emitsLight !== undefined ? { emitsLight: it.emitsLight } : {}),
            ...(it.presentation ? { presentation: { ...it.presentation } } : {}),
          },
          firstSeen,
        };
      }
      break;
    }
    case "room": {
      const r = event.room;
      entry = {
        kind: "room",
        key: r.id,
        snapshot: {
          name: r.name,
          description: r.description,
          ...(r.presentation ? { presentation: { ...r.presentation } } : {}),
        },
        firstSeen,
      };
      break;
    }
    case "recipe": {
      const rec = event.recipe;
      const output = rec.create();
      entry = {
        kind: "recipe",
        key: rec.id,
        snapshot: {
          id: rec.id,
          outputName: output.name,
          ...("materials" in rec ? { materials: { ...rec.materials } } : {}),
          ...("keys" in rec ? { keys: rec.keys.map((k) => ({ ...k })) } : {}),
          ...(output.presentation ? { outputPresentation: { ...output.presentation } } : {}),
        },
        firstSeen,
      };
      break;
    }
    case "material": {
      entry = {
        kind: "material",
        key: event.material,
        snapshot: { type: event.material },
        firstSeen,
      };
      break;
    }
  }
  deepFreeze(entry.snapshot);
  Object.freeze(entry);
  return entry;
}

/**
 * Party-wide record of everything the party has encountered. Entries are keyed
 * by `${kind}::${syntheticKey}` and are first-write-wins: a repeat encounter is
 * a no-op that preserves the original first-seen stamp.
 */
export class Codex implements ICodex {
  #entries = new Map<string, CodexEntry>();

  /** Records an encounter. First-write-wins by `kind` + synthetic key. */
  record(event: CodexEncounterEvent, firstSeen: CodexFirstSeen): void {
    const entry = buildEntry(event, deepFreeze({ ...firstSeen }));
    const mapKey = `${entry.kind}::${entry.key}`;
    if (this.#entries.has(mapKey)) return;
    this.#entries.set(mapKey, entry);
  }

  #sortedOfKind<E extends CodexEntry>(kind: CodexKind): readonly E[] {
    const list = [...this.#entries.values()].filter((e) => e.kind === kind) as E[];
    list.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    return Object.freeze(list);
  }

  get mobs() {
    return this.#sortedOfKind<Extract<CodexEntry, { kind: "mob" }>>("mob");
  }
  get items() {
    return this.#sortedOfKind<Extract<CodexEntry, { kind: "item" }>>("item");
  }
  get keys() {
    return this.#sortedOfKind<Extract<CodexEntry, { kind: "key" }>>("key");
  }
  get rooms() {
    return this.#sortedOfKind<Extract<CodexEntry, { kind: "room" }>>("room");
  }
  get recipes() {
    return this.#sortedOfKind<Extract<CodexEntry, { kind: "recipe" }>>("recipe");
  }
  get materials() {
    return this.#sortedOfKind<Extract<CodexEntry, { kind: "material" }>>("material");
  }

  get all(): readonly CodexEntry[] {
    return Object.freeze([...this.#entries.values()]);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(kind: CodexKind, key: string): CodexEntry | undefined {
    return this.#entries.get(`${kind}::${key}`);
  }

  /** Restores pre-built frozen entries directly, preserving each entry's original `firstSeen`. */
  [HYDRATE_CODEX](entries: CodexEntry[]): void {
    for (const entry of entries) {
      deepFreeze(entry);
      this.#entries.set(`${entry.kind}::${entry.key}`, entry);
    }
  }
}
