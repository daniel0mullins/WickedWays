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
  const { rng = Math.random, extraConnections = 0 } = options;
  void rng;
  void extraConnections;
  void OPPOSITES;
  void ALL_DIRECTIONS;

  if (rooms.length <= 1) {
    return rooms;
  }

  return rooms;
}
