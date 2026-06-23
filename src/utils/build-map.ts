import { Directions, IRoom } from "../lib/room";
import { ProceduralViolation } from "../lib/util";

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
  /**
   * Pairs of rooms that must share a direct exit. Laid down before the
   * spanning tree so they're (almost) always honored. Best-effort: a pair is
   * skipped if it can't be placed (same room, already adjacent, or no free
   * direction left on either room). Order within a pair is irrelevant; exits
   * are bidirectional.
   */
  requiredConnections?: [IRoom, IRoom][];
}

/**
 * Connects a set of rooms into a navigable map in place.
 *
 * First lays down any {@link BuildMapOptions.requiredConnections} as direct
 * adjacencies, then a random spanning tree so every room is reachable, then up
 * to {@link BuildMapOptions.extraConnections} loop/shortcut edges. Each
 * connection is bidirectional, using opposite compass directions, and respects
 * the eight available directions per room. Required connections are best-effort:
 * an impossible pair (same room, already adjacent, or no free direction) is
 * skipped. The same `rooms` array is returned (mutated); a single room or empty
 * array is returned untouched.
 *
 * Connecting the rooms is best-effort, but reachability is not: if any room
 * cannot be wired into the map (its component is fully saturated), the whole map
 * is invalid and this throws rather than leaving a stranded room.
 *
 * @param rooms - The rooms to wire together; their `exits` are mutated.
 * @param options - Randomness source and extra-edge configuration.
 * @returns The same `rooms` array, now connected.
 * @throws {@link ProceduralViolation} if a room cannot be connected to the map.
 */
export function buildMap(
  rooms: IRoom[],
  options: BuildMapOptions = {},
): IRoom[] {
  const {
    rng = Math.random,
    extraConnections = 0,
    requiredConnections = [],
  } = options;

  if (rooms.length <= 1) {
    return rooms;
  }

  // Phase 1: honor required adjacencies first, before the tree and extras
  // compete for direction slots. connect() is best-effort: it returns false
  // for same-room, already-adjacent, or saturated pairs, which we skip.
  for (const [a, b] of requiredConnections) {
    connect(a, b, rng);
  }

  // Phase 2: spanning tree over the components the required edges created.
  // Union-find tracks which rooms are already mutually reachable so we only
  // add the filler edges needed to merge everything into one component.
  const parent = new Map<IRoom, IRoom>();
  const find = (room: IRoom): IRoom => {
    let root = room;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let cursor = room;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: IRoom, b: IRoom): void => {
    parent.set(find(a), find(b));
  };

  for (const room of rooms) {
    parent.set(room, room);
  }
  for (const room of rooms) {
    for (const neighbor of room.exits.values()) {
      union(room, neighbor);
    }
  }

  const order = shuffle(rooms, rng);
  const anchor = order[0]!;
  const connected: IRoom[] = order.filter((r) => find(r) === find(anchor));

  for (const room of order) {
    if (find(room) === find(anchor)) {
      continue;
    }
    const candidates = connected.filter((r) => freeDirections(r).length > 0);
    // Empty only if every room in the main component is saturated (all eight
    // directions used), which requires a pathologically dense map. We can't
    // attach this room here; the post-loop connectivity check turns any room
    // left unreachable into a ProceduralViolation.
    if (candidates.length === 0) {
      continue;
    }
    const target = candidates[Math.floor(rng() * candidates.length)]!;
    if (connect(target, room, rng)) {
      union(target, room);
      for (const r of order) {
        if (find(r) === find(anchor) && !connected.includes(r)) {
          connected.push(r);
        }
      }
    }
  }

  // Every room must be reachable from the anchor. A room the best-effort tree
  // could not attach (its whole component saturated, or itself saturated with no
  // free opposite direction) would be unreachable — an authoring error, not a
  // silent dead end.
  const stranded = rooms.filter((room) => find(room) !== find(anchor));
  if (stranded.length > 0) {
    throw new ProceduralViolation(
      `buildMap could not connect ${stranded.length} room(s) to the map: ` +
        stranded.map((room) => room.name).join(", "),
    );
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
