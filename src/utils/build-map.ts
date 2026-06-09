import { Directions, IRoom } from "../lib/room";

type Direction = (typeof Directions)[keyof typeof Directions];

const ALL_DIRECTIONS = Object.values(Directions) as Direction[];

const OPPOSITES: Record<Direction, Direction> = {
  [Directions.North]: Directions.South,
  [Directions.South]: Directions.North,
  [Directions.East]: Directions.West,
  [Directions.West]: Directions.East,
  [Directions.Northeast]: Directions.Southwest,
  [Directions.Southwest]: Directions.Northeast,
  [Directions.Northwest]: Directions.Southeast,
  [Directions.Southeast]: Directions.Northwest,
} as const;

export interface BuildMapOptions {
  /** 0..1 random source. Default: Math.random. Inject for deterministic tests. */
  rng?: () => number;
  /**
   * Loop/shortcut edges beyond the spanning tree. Default: 0.
   * - Integer >= 1: absolute edge count (floored).
   * - In (0, 1): fraction of (n-1) edges, rounded.
   * - <= 0: no extras.
   * Delivery is best-effort; fewer edges are added if the graph is saturated.
   */
  extraConnections?: number;
}

/**
 * Connects a set of rooms into a navigable map in place.
 *
 * First lays down a random spanning tree so every room is reachable, then adds
 * up to {@link BuildMapOptions.extraConnections} loop/shortcut edges. Each
 * connection is bidirectional, using opposite compass directions, and respects
 * the eight available directions per room. The same `rooms` array is returned
 * (mutated); a single room or empty array is returned untouched.
 *
 * @param rooms - The rooms to wire together; their `exits` are mutated.
 * @param options - Randomness source and extra-edge configuration.
 * @returns The same `rooms` array, now connected.
 */
export function buildMap(
  rooms: IRoom[],
  options: BuildMapOptions = {},
): IRoom[] {
  const { rng = Math.random, extraConnections = 0 } = options;

  if (rooms.length <= 1) {
    return rooms;
  }

  const order = shuffle(rooms, rng);
  const connected: IRoom[] = [order[0]!];

  for (let i = 1; i < order.length; i++) {
    const room = order[i]!;
    // A spanning tree always has a connected room with a free slot (leaves have
    // degree 1), so this list is never empty during tree construction.
    const candidates = connected.filter((r) => freeDirections(r).length > 0);
    const target = candidates[Math.floor(rng() * candidates.length)]!;
    connect(target, room, rng);
    connected.push(room);
  }

  const extra = resolveExtraConnections(extraConnections, rooms.length);
  let added = 0;
  let attempts = 0;
  const maxAttempts = extra * rooms.length * 2;
  while (added < extra && attempts < maxAttempts) {
    const a = rooms[Math.floor(rng() * rooms.length)]!;
    const b = rooms[Math.floor(rng() * rooms.length)]!;
    if (connect(a, b, rng)) {
      added++;
    }
    attempts++;
  }

  return rooms;
}

function connect(a: IRoom, b: IRoom, rng: () => number): boolean {
  if (a === b || areAdjacent(a, b)) {
    return false;
  }
  for (const direction of shuffle(freeDirections(a), rng)) {
    const opposite = OPPOSITES[direction];
    if (!b.exits.has(opposite)) {
      a.addExit(direction, b);
      b.addExit(opposite, a);
      return true;
    }
  }
  return false;
}

function areAdjacent(a: IRoom, b: IRoom): boolean {
  for (const room of a.exits.values()) {
    if (room === b) {
      return true;
    }
  }
  return false;
}

function freeDirections(room: IRoom): Direction[] {
  return ALL_DIRECTIONS.filter((direction) => !room.exits.has(direction));
}

function resolveExtraConnections(extra: number, roomCount: number): number {
  if (extra <= 0) {
    return 0;
  }
  if (extra < 1) {
    return Math.round(extra * (roomCount - 1));
  }
  return Math.floor(extra);
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
