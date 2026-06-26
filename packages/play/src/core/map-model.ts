import { type Direction, reverseDirection } from "wickedways/lib/room";
import type { ViewModel } from "./viewmodel.js";

/** A room placed on the fog-of-war grid. */
export interface MapRoom { id: string; name: string; x: number; y: number; hasRemains: boolean; }
/** A traversed connection between two rooms (`dir` is from `a` to `b`). */
export interface MapEdge { a: string; b: string; dir: Direction; locked: boolean; }
/** An exit seen but not yet walked through. */
export interface MapStub { dir: Direction; locked: boolean; }
/** Plain-data snapshot of the whole map, for save/restore. */
export interface MapSnapshot {
  rooms: MapRoom[];
  edges: MapEdge[];
  stubs: { roomId: string; stubs: MapStub[] }[];
  currentId: string | null;
}

/** Grid step per direction (north = up). Shared with the map layout. */
export const DIRECTION_DELTA: Record<Direction, { dx: number; dy: number }> = {
  north: { dx: 0, dy: -1 }, south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 }, west: { dx: -1, dy: 0 },
  northeast: { dx: 1, dy: -1 }, northwest: { dx: -1, dy: -1 },
  southeast: { dx: 1, dy: 1 }, southwest: { dx: -1, dy: 1 },
};

/**
 * Fog-of-war map of the house, built incrementally from what the play surface
 * sees each turn. Pure (no DOM); the renderer reads it via the getters.
 */
export class MapModel {
  #rooms = new Map<string, MapRoom>();
  #edges: MapEdge[] = [];
  #stubs = new Map<string, MapStub[]>();
  #currentId: string | null = null;

  get currentId(): string | null { return this.#currentId; }
  rooms(): MapRoom[] { return [...this.#rooms.values()]; }
  edges(): readonly MapEdge[] { return this.#edges; }
  stubsFor(id: string): readonly MapStub[] { return this.#stubs.get(id) ?? []; }

  /** Record/refresh the room the player is currently in. */
  observe(view: ViewModel): void {
    const { id, name } = view.room;
    const hasRemains = view.occupants.some((o) => o.defeated);
    const existing = this.#rooms.get(id);
    if (existing) {
      existing.name = name;
      existing.hasRemains = hasRemains;
    } else {
      // Only the first room is created here (at the origin); every other room is
      // placed by recordMove before it is first observed.
      this.#rooms.set(id, { id, name, x: 0, y: 0, hasRemains });
    }
    this.#currentId = id;

    // Directions already traversed from this room get no stub.
    const traversed = new Set<Direction>();
    for (const e of this.#edges) {
      if (e.a === id) traversed.add(e.dir);
      if (e.b === id) traversed.add(reverseDirection(e.dir));
    }
    const stubs: MapStub[] = [];
    for (const ex of view.exits) if (!traversed.has(ex.dir)) stubs.push({ dir: ex.dir, locked: false });
    for (const d of view.lockedDoors) if (!traversed.has(d.dir)) stubs.push({ dir: d.dir, locked: true });
    this.#stubs.set(id, stubs);
  }

  /** Record a traversal: place `to` relative to `from`, add the edge, drop the stub. */
  recordMove(fromId: string, dir: Direction, toId: string): void {
    const from = this.#rooms.get(fromId);
    if (from && !this.#rooms.has(toId)) {
      const { dx, dy } = DIRECTION_DELTA[dir];
      this.#rooms.set(toId, { id: toId, name: toId, x: from.x + dx, y: from.y + dy, hasRemains: false });
    }
    const known = this.#edges.some((e) =>
      (e.a === fromId && e.b === toId) || (e.a === toId && e.b === fromId));
    if (!known) this.#edges.push({ a: fromId, b: toId, dir, locked: false });
    const fromStubs = this.#stubs.get(fromId);
    if (fromStubs) this.#stubs.set(fromId, fromStubs.filter((s) => s.dir !== dir));
  }

  serialize(): MapSnapshot {
    return {
      rooms: this.rooms().map((r) => ({ ...r })),
      edges: this.#edges.map((e) => ({ ...e })),
      stubs: [...this.#stubs.entries()].map(([roomId, stubs]) => ({ roomId, stubs: stubs.map((s) => ({ ...s })) })),
      currentId: this.#currentId,
    };
  }

  hydrate(snap: MapSnapshot): void {
    this.#rooms = new Map(snap.rooms.map((r) => [r.id, { ...r }]));
    this.#edges = snap.edges.map((e) => ({ ...e }));
    this.#stubs = new Map(snap.stubs.map((s) => [s.roomId, s.stubs.map((x) => ({ ...x }))]));
    this.#currentId = snap.currentId;
  }

  reset(): void {
    this.#rooms = new Map();
    this.#edges = [];
    this.#stubs = new Map();
    this.#currentId = null;
  }
}
