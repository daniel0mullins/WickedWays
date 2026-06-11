import { describe, expect, it } from "vitest";

import { Campaign } from "./campaign";
import { EncounterTable, type Formation } from "./encounter-table";
import { Mob } from "./character/mob";
import { Room } from "./room";
import { Status } from "./status";
import { createKey } from "./inventory";
import { ProceduralViolation } from "./util";
import { makeStats, type ExitsArg } from "../test-utils";

function goblinFormation(id: string, weight: number): Formation {
  return {
    id,
    weight,
    build: (campaign) => [new Mob(campaign, `Goblin-${id}`, makeStats(), 2, 2, [])],
  };
}

function room(modifier = 1): Room {
  return new Room("Cave", "Cave", [], {} as ExitsArg, [], modifier);
}

describe("EncounterTable", () => {
  describe("addFormation", () => {
    it("rejects a formation whose mobs carry key-item drops", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      const formation: Formation = {
        id: "thief",
        weight: 1,
        build: (c) => [
          new Mob(c, "Thief", makeStats(), 2, 2, [
            createKey({ name: "Loot Key", keyCode: "loot", consumeOnUse: false }),
          ]),
        ],
      };

      expect(() => table.addFormation(formation, campaign)).toThrow(ProceduralViolation);
    });

    it("accepts a formation with no key drops", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      expect(() => table.addFormation(goblinFormation("a", 1), campaign)).not.toThrow();
    });
  });

  describe("maybeSpawn", () => {
    it("spawns into the room when the roll passes on first visit", () => {
      const table = new EncounterTable(() => 0, 50); // roll 1 <= 50*1
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room(1);

      const spawned = table.maybeSpawn(cave, campaign);

      expect(spawned).toHaveLength(1);
      expect(cave.occupants).toContain(spawned[0]);
      expect(spawned[0]!.currentRoom).toBe(cave);
    });

    it("does not spawn on a revisit", () => {
      const table = new EncounterTable(() => 0, 50);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room();

      table.maybeSpawn(cave, campaign); // first visit consumes the chance
      const second = table.maybeSpawn(cave, campaign);

      expect(second).toHaveLength(0);
    });

    it("does not spawn when the roll fails", () => {
      const table = new EncounterTable(() => 0.99, 50); // roll 100 > 50
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);

      expect(table.maybeSpawn(room(), campaign)).toHaveLength(0);
    });

    it("never spawns in a safe room (spawnModifier 0)", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);

      expect(table.maybeSpawn(room(0), campaign)).toHaveLength(0);
    });

    it("suppresses spawning when an active mob is already present", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room();
      cave.placeMob(new Mob(campaign, "Resident", makeStats(), 2, 2, []));

      expect(table.maybeSpawn(cave, campaign)).toHaveLength(0);
    });

    it("marks spawned mobs with campaign origin (no key drops)", () => {
      const table = new EncounterTable(() => 0, 100);
      const campaign = new Campaign("C");
      table.addFormation(goblinFormation("a", 1), campaign);
      const cave = room();

      const [mob] = table.maybeSpawn(cave, campaign);

      expect(mob!.status).not.toContain(Status.KO);
      expect(mob!.currentRoom).toBe(cave);
    });
  });
});
