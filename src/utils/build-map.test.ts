import { describe, expect, it } from "vitest";

import { Room } from "../lib/room";
import type { IRoom } from "../lib/room";
import { buildMap } from "./build-map";

type ExitsArg = ConstructorParameters<typeof Room>[2];

function makeRooms(count: number): IRoom[] {
  return Array.from(
    { length: count },
    () => new Room("a room", [], {} as ExitsArg),
  );
}

const OPPOSITE: Record<string, string> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  northeast: "southwest",
  southwest: "northeast",
  northwest: "southeast",
  southeast: "northwest",
};

function reachableCount(start: IRoom): number {
  const seen = new Set<IRoom>([start]);
  const queue: IRoom[] = [start];
  while (queue.length > 0) {
    const room = queue.shift()!;
    for (const next of room.exits.values()) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size;
}

function edgeCount(rooms: IRoom[]): number {
  let total = 0;
  for (const room of rooms) {
    total += room.exits.size;
  }
  return total / 2;
}

describe("buildMap", () => {
  it("returns an empty array unchanged", () => {
    expect(buildMap([])).toEqual([]);
  });

  it("returns a single room unchanged with no exits", () => {
    const rooms = makeRooms(1);

    const result = buildMap(rooms);

    expect(result).toBe(rooms);
    const [room] = rooms;
    expect(room!.exits.size).toBe(0);
  });

  describe("spanning tree", () => {
    it("makes every room reachable from the first room", () => {
      const rooms = buildMap(makeRooms(12));

      expect(reachableCount(rooms[0]!)).toBe(12);
    });

    it("produces exactly n-1 undirected edges with no extra connections", () => {
      const rooms = buildMap(makeRooms(12));

      expect(edgeCount(rooms)).toBe(11);
    });

    it("makes every exit bidirectional with the opposite direction", () => {
      const rooms = buildMap(makeRooms(12));

      for (const room of rooms) {
        for (const [direction, dest] of room.exits.entries()) {
          expect(dest.exits.get(OPPOSITE[direction]! as keyof ExitsArg)).toBe(room);
        }
      }
    });

    it("never connects a room to itself", () => {
      const rooms = buildMap(makeRooms(12));

      for (const room of rooms) {
        expect([...room.exits.values()]).not.toContain(room);
      }
    });

    it("never gives a room more than 8 exits", () => {
      const rooms = buildMap(makeRooms(30));

      for (const room of rooms) {
        expect(room.exits.size).toBeLessThanOrEqual(8);
      }
    });
  });
});
