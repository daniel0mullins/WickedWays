import { describe, expect, it } from "vitest";

import { Room } from "../lib/room";
import type { IRoom } from "../lib/room";
import { buildMap } from "./build-map";

import { type ExitsArg, makeRng } from "../test-utils";

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

function exitSignature(rooms: IRoom[]): string {
  const index = new Map<IRoom, number>(rooms.map((r, i) => [r, i]));
  return rooms
    .map((room, i) =>
      [...room.exits.entries()]
        .map(([dir, dest]) => `${i}:${dir}->${index.get(dest)}`)
        .sort()
        .join(","),
    )
    .join("|");
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

  describe("extraConnections", () => {
    it("adds extra edges as an absolute integer count", () => {
      const rooms = buildMap(makeRooms(12), { extraConnections: 3 });

      // n-1 tree edges (11) plus up to 3 extras; each extra only skips when no
      // free-slot pair exists, which cannot happen for 12 rooms with <=8 exits.
      expect(edgeCount(rooms)).toBe(14);
    });

    it("treats a value in (0,1) as a fraction of (n-1)", () => {
      // 0.5 * (12 - 1) = 5.5 -> rounds to 6 extra edges.
      const rooms = buildMap(makeRooms(12), { extraConnections: 0.5 });

      expect(edgeCount(rooms)).toBe(17);
    });

    it("adds nothing for a value of 0", () => {
      const rooms = buildMap(makeRooms(12), { extraConnections: 0 });

      expect(edgeCount(rooms)).toBe(11);
    });

    it("keeps every exit bidirectional after adding extras", () => {
      const rooms = buildMap(makeRooms(12), { extraConnections: 5 });

      for (const room of rooms) {
        for (const [direction, dest] of room.exits.entries()) {
          expect(dest.exits.get(OPPOSITE[direction]! as keyof ExitsArg)).toBe(room);
        }
      }
    });
  });

  describe("determinism", () => {
    it("produces identical structure for the same seed", () => {
      const first = buildMap(makeRooms(15), {
        rng: makeRng(42),
        extraConnections: 4,
      });
      const second = buildMap(makeRooms(15), {
        rng: makeRng(42),
        extraConnections: 4,
      });

      expect(exitSignature(first)).toBe(exitSignature(second));
    });

    it("produces different structure for different seeds", () => {
      const first = buildMap(makeRooms(15), { rng: makeRng(1) });
      const second = buildMap(makeRooms(15), { rng: makeRng(2) });

      expect(exitSignature(first)).not.toBe(exitSignature(second));
    });
  });
});
