/**
 * facade-ko-piling golden — proves the runMobReactions "don't pile on a downed
 * player" break (session.ts:174). Two mobs share the PC's room; the PC has
 * sanity 0 (mitigation multiplier 2.0 → each strike deals 2 health) and health
 * 3, so the SECOND mob's strike floors health to 0 and latches KO. The loop must
 * break AFTER the KO strike (both mobs act on step 0), and a subsequent
 * advancing op on the downed PC must draw ZERO further strikes.
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
const SEED = 0xfacade3;
const EMPTY_CATALOG = { items: {}, aliases: {} };

describe("generate facade-ko-piling golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });
    const template = authorTemplate("Facade KO Piling (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        // sanity 0 → mitigation ×2.0 → each strike deals 2 health; health 3 →
        // First: 3→1, Second: 1→0 → KO latch → loop breaks after Second.
        baseStats: { [StatType.Health]: 3, [StatType.Sanity]: 0, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .mob("First", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" })
      .mob("Second", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "wait" } }, // both mobs strike; Second KOs the PC
      { kind: "submit", intent: { kind: "wait" } }, // PC downed → reactions empty
    ];
    const steps = writeFacadeFixture(here, "facade-ko-piling", SEED, oracle, EMPTY_CATALOG, ops);

    const r0 = steps[0]!.result as { mobAttacks?: { name: string }[] };
    const names = (r0.mobAttacks ?? []).map((a) => a.name);
    if (names[names.length - 1] !== "Second" || new Set(names).size !== names.length) {
      throw new Error(`expected piling to stop at the KO strike, got ${JSON.stringify(names)}`);
    }
    const r1 = steps[1]!.result as { mobAttacks?: unknown[] };
    if ((r1.mobAttacks ?? []).length !== 0) {
      throw new Error("a downed player must not be piled on");
    }
  });
});
