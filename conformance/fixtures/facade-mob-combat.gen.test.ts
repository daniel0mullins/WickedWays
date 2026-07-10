/**
 * facade-mob-combat golden — the FIRST differential coverage of
 * runMobReactions + the execute turn-wrap.
 *
 * One PC (Ada, base sanity 3) shares "Hall" with two authored mobs. Sanity 3
 * puts the PC inside the Fear band (0 < sanity < 5), so the engine ITSELF
 * latches Fear at the first startTurn, and every subsequent startTurn draws a
 * shake-off clear roll — a genuine, engine-derived rng-draw consumer threaded
 * through the wrap on BOTH sides (startTurn tick + clear roll → dispatch →
 * mob strikes → nextPlayer). Fear blocks MOVE only, so wait/attack proceed.
 * Any specific shake-off round is fine — the SAME seeded stream must
 * reproduce the exchange byte-for-byte in Rust.
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
const SEED = 0xfacade1;
const EMPTY_CATALOG = { items: {}, aliases: {} };

describe("generate facade-mob-combat golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });
    const template = authorTemplate("Facade Mob Combat (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        // sanity 3 → Fear band → clear roll drawn at every startTurn (see header)
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 3, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .mob("Brute", { stats: { [StatType.Health]: 6, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" })
      .mob("Shade", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "wait" } },                        // both mobs strike; Fear latches
      { kind: "submit", intent: { kind: "wait" } },                        // clear roll drawn; strikes again
      { kind: "submit", intent: { kind: "attack", targetId: "mob:Brute" } }, // PC hits back mid-exchange
      { kind: "submit", intent: { kind: "wait" } },
    ];
    const steps = writeFacadeFixture(here, "facade-mob-combat", SEED, oracle, EMPTY_CATALOG, ops, template.description);

    // Coverage bar: the exchange actually happened — step 0 carries mob strikes.
    const r0 = steps[0]!.result as { mobAttacks?: { name: string }[] };
    if (!r0.mobAttacks || r0.mobAttacks.length < 2) {
      throw new Error(`expected both mobs to strike on step 0, got ${JSON.stringify(r0.mobAttacks)}`);
    }
  });
});
