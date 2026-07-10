/**
 * facade-lit-entry golden — differential coverage of light-tied mob initiative
 * (spec: docs/superpowers/specs/2026-07-07-light-tied-mob-initiative-design.md).
 *
 * The PC starts in "Hall" (lit) with no weapon; a live mob "Brute" waits in the
 * adjacent lit room "Cell". Op 0 moves Hall→Cell: entering a LIT room with a mob
 * must NOT provoke an entry swing (the feature) — the player who can see gets the
 * drop. Op 1 attacks Brute in that same room: co-located combat still reacts, so
 * the mob counters (the control that proves the mob wasn't globally disabled).
 * The seeded stream must reproduce both byte-for-byte in the Rust Authority.
 *
 * The dark-entry-still-ambushes and wait-still-provokes controls live as Rust
 * unit tests in world/submit.rs (they exercise unchanged behavior).
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x11fed;
const EMPTY_CATALOG = { items: {}, aliases: {} };

describe("generate facade-lit-entry golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });
    const template = authorTemplate("Facade Lit Entry (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .room("Cell", { description: "A lit cell." }) // NOT dark → lit
      .startRoom("Hall")
      .exit("Hall", Directions.North, "Cell")
      .exit("Cell", Directions.South, "Hall")
      // Brute waits in the destination; health 6 so it survives the PC's unarmed
      // swing and can counter on op 1.
      .mob("Brute", { stats: { [StatType.Health]: 6, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Cell" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "move", dir: Directions.North } }, // lit entry → NO ambush
      { kind: "submit", intent: { kind: "attack", targetId: "mob:Brute" } }, // co-located → mob counters
    ];
    const steps = writeFacadeFixture(here, "facade-lit-entry", SEED, oracle, EMPTY_CATALOG, ops, template.description);

    // Coverage bar — the feature and its control both actually fired.
    const entry = steps[0]!.result as { mobAttacks?: unknown[]; error?: string };
    if (entry.error !== undefined) throw new Error(`entry move errored: ${entry.error}`);
    if (entry.mobAttacks && entry.mobAttacks.length > 0) {
      throw new Error(`lit entry must not provoke a swing, got ${JSON.stringify(entry.mobAttacks)}`);
    }
    const fight = steps[1]!.result as { mobAttacks?: unknown[] };
    if (!fight.mobAttacks || fight.mobAttacks.length < 1) {
      throw new Error(`attacking a live co-located mob must draw a counter, got ${JSON.stringify(fight.mobAttacks)}`);
    }
  });
});
