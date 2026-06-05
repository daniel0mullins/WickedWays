import { Directions, IRoom } from "../lib/room";

type Direction = (typeof Directions)[keyof typeof Directions];

const ALL_DIRECTIONS = Object.values(Directions) as Direction[];

const OPPOSITES: Record<Direction, Direction> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  northeast: "southwest",
  southwest: "northeast",
  northwest: "southeast",
  southeast: "northwest",
};

export interface BuildMapOptions {
  /** 0..1 random source. Default: Math.random. Inject for deterministic tests. */
  rng?: () => number;
  /** Loop/shortcut edges beyond the spanning tree. Default: 0. */
  extraConnections?: number;
}

export function buildMap(
  rooms: IRoom[],
  options: BuildMapOptions = {},
): IRoom[] {
  const { rng = Math.random } = options;

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

function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
