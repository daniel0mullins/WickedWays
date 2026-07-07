/**
 * facade-afflicted-mob golden — proves the runMobReactions "skip a blocked mob,
 * keep going" arm (session.ts:165-168). Two mobs share the PC's room; the PC
 * attacks "Blocked" (a sanity-0 mob) first, whose take_damage → reconcile
 * latches Panic (Panicked: can only move). From the next reaction round the
 * blocked mob's attack gate throws a ProceduralViolation that runMobReactions
 * swallows, while "Free" still strikes — the loop skips-and-continues.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade4;
const EMPTY_CATALOG = { items: {}, aliases: {} };

describe("generate facade-afflicted-mob golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });
    const template = authorTemplate("Facade Afflicted Mob (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        // High sanity keeps the PC free of Fear/Panic so only the mob's latch matters.
        baseStats: { [StatType.Health]: 20, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      // sanity 0 → Panic latches on reconcile after taking damage.
      .mob("Blocked", { stats: { [StatType.Health]: 8, [StatType.Sanity]: 0, [StatType.Energy]: 4 }, room: "Hall" })
      .mob("Free", { stats: { [StatType.Health]: 8, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "attack", targetId: "mob:Blocked" } }, // latches Panic on Blocked
      { kind: "submit", intent: { kind: "wait" } },
      { kind: "submit", intent: { kind: "wait" } },
    ];
    const steps = writeFacadeFixture(here, "facade-afflicted-mob", SEED, oracle, EMPTY_CATALOG, ops);

    for (const s of steps.slice(1)) {
      const names = ((s.result as { mobAttacks?: { name: string }[] }).mobAttacks ?? []).map((a) => a.name);
      if (names.includes("Blocked")) throw new Error("blocked mob must not strike");
      if (!names.includes("Free")) throw new Error("free mob must still strike");
    }
  });
});
