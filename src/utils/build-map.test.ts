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
});
