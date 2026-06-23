import { describe, expect, it } from "vitest";

import { Directions, Room } from "../lib/room";
import type { IRoom } from "../lib/room";
import { ProceduralViolation } from "../lib/util";
import { buildMap } from "./build-map";

import { type ExitsArg, makeRng } from "../test-utils";

function makeRooms(count: number): IRoom[] {
  return Array.from(
    { length: count },
    () => new Room({ name: "a room", description: "a room", loot: [] }),
  );
}

// Wires every room to all the others, one neighbor per compass direction, so
// each ends up with all eight exits occupied (no free direction left).
function saturate(rooms: IRoom[]): void {
  const directions = Object.values(Directions);
  for (const room of rooms) {
    const others = rooms.filter((r) => r !== room);
    directions.forEach((dir, i) => {
      const dest = others[i];
      if (dest) room.addExit(dir, dest);
    });
  }
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

  describe("connectivity", () => {
    it("connects a room created without an exits argument", () => {
      const a = new Room({ name: "A", description: "a", loot: [] });
      const b = new Room({ name: "B", description: "b", loot: [] });

      buildMap([a, b], { rng: makeRng(1) });

      expect(reachableCount(a)).toBe(2);
    });

    it("throws a ProceduralViolation when a room cannot be connected", () => {
      // A fully saturated component leaves no free direction for the lone
      // straggler to attach to, so it can never be reached.
      const saturated = makeRooms(9);
      saturate(saturated);
      const straggler = new Room({ name: "Straggler", description: "alone", loot: [] }); // exits arg omitted

      expect(() =>
        buildMap([...saturated, straggler], { rng: makeRng(1) }),
      ).toThrow(ProceduralViolation);
    });
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

  describe("requiredConnections", () => {
    function directionBetween(a: IRoom, b: IRoom): string | undefined {
      for (const [dir, dest] of a.exits.entries()) {
        if (dest === b) return dir;
      }
      return undefined;
    }

    it("makes a required pair directly adjacent on opposite directions", () => {
      const rooms = makeRooms(12);
      const [a, b] = [rooms[0]!, rooms[7]!];

      buildMap(rooms, { rng: makeRng(42), requiredConnections: [[a, b]] });

      const dir = directionBetween(a, b);
      expect(dir).toBeDefined();
      expect(b.exits.get(OPPOSITE[dir!]! as keyof ExitsArg)).toBe(a);
    });

    it("honors multiple required pairs at once", () => {
      const rooms = makeRooms(12);
      const pairs: [IRoom, IRoom][] = [
        [rooms[0]!, rooms[1]!],
        [rooms[2]!, rooms[3]!],
        [rooms[4]!, rooms[5]!],
      ];

      buildMap(rooms, { rng: makeRng(7), requiredConnections: pairs });

      for (const [a, b] of pairs) {
        expect([...a.exits.values()]).toContain(b);
        expect([...b.exits.values()]).toContain(a);
      }
    });

    it("keeps every room reachable with required edges present", () => {
      const rooms = makeRooms(12);

      buildMap(rooms, {
        rng: makeRng(3),
        requiredConnections: [
          [rooms[0]!, rooms[11]!],
          [rooms[5]!, rooms[6]!],
        ],
      });

      expect(reachableCount(rooms[0]!)).toBe(12);
    });

    it("skips a self-pair without throwing and still builds the map", () => {
      const rooms = makeRooms(12);

      expect(() =>
        buildMap(rooms, {
          rng: makeRng(9),
          requiredConnections: [[rooms[0]!, rooms[0]!]],
        }),
      ).not.toThrow();

      expect([...rooms[0]!.exits.values()]).not.toContain(rooms[0]!);
      expect(reachableCount(rooms[0]!)).toBe(12);
    });

    it("skips required edges beyond a room's 8-direction capacity", () => {
      // 10 partners all required-adjacent to one hub: at most 8 can attach.
      const rooms = makeRooms(11);
      const hub = rooms[0]!;
      const pairs = rooms.slice(1).map((r) => [hub, r] as [IRoom, IRoom]);

      buildMap(rooms, { rng: makeRng(11), requiredConnections: pairs });

      expect(hub.exits.size).toBeLessThanOrEqual(8);
      expect(reachableCount(rooms[0]!)).toBe(11);
    });

    it("coexists with extraConnections", () => {
      const rooms = makeRooms(12);

      buildMap(rooms, {
        rng: makeRng(5),
        requiredConnections: [[rooms[0]!, rooms[1]!]],
        extraConnections: 3,
      });

      expect([...rooms[0]!.exits.values()]).toContain(rooms[1]!);
      expect(reachableCount(rooms[0]!)).toBe(12);
      for (const room of rooms) {
        expect(room.exits.size).toBeLessThanOrEqual(8);
      }
    });

    it("is deterministic for the same seed and required pairs", () => {
      const build = () => {
        const rooms = makeRooms(15);
        return buildMap(rooms, {
          rng: makeRng(42),
          requiredConnections: [[rooms[0]!, rooms[9]!]],
          extraConnections: 2,
        });
      };

      expect(exitSignature(build())).toBe(exitSignature(build()));
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
