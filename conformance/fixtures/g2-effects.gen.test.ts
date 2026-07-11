/**
 * g2-effects oracle fixture — the TS twin for the G2 "remaining effects" author
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-effects-design.md).
 * It proves the author can emit the three effects no committed hollow-house behavior
 * uses — `damage`, `heal`, `grantImmunity` — plus the `defined(...)` guard, so the
 * effect/expression surface is complete. A bespoke `hex` mechanic (there is no real
 * oracle for these) whose `onTurnStart`, when the actor is in a room, deals 2, heals
 * 1, and grants 3 turns of immunity.
 *
 * DUAL ENCODING: the mechanic is authored TWICE for the key `hex` — a native
 * `Mechanic` twin in the REGISTRY (its `initialState: () => ({})` seeds the genesis
 * state; the onTurnStart closure mirrors the DSL) and the `s.mechanic(...)` DSL twin
 * in `catalog.behaviors` (the byte-parity TARGET). Real campaigns are TOML-only.
 *
 * Writes g2-effects.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { mulberry32 } from "../seeded-rng.ts";
import type { Effect, Mechanic } from "wickedways/lib/mechanics/mechanic";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_ef; // "g2ef"; no rng draws in this pristine pre-begin genesis.

const MECH_KEY = "hex";

// Native registry twin — its onTurnStart mirrors the DSL twin (never fires in this
// pre-begin capture, but pins the intended behavior so the twins cannot drift).
const hex: Mechanic<Record<string, never>, void, never> = {
  initialState: () => ({}),
  onTurnStart: (h) => {
    if (h.actor.roomId === undefined) return [];
    const effects: Effect[] = [
      { kind: "damage", target: h.actor.id, amount: 2 },
      { kind: "heal", target: h.actor.id, amount: 1 },
      { kind: "grantImmunity", target: h.actor.id, turns: 3 },
    ];
    return effects;
  },
};

describe("generate g2-effects oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    const registry = defineRegistry({
      items: {},
      mechanics: { [MECH_KEY]: hex },
    });

    const template = authorTemplate("Effects", registry, { rng })
      .room("Hall", { description: "A cold stone hall." })
      .startRoom("Hall")
      .useMechanic(MECH_KEY);

    const behaviors = {
      [MECH_KEY]: s.mechanic({
        init: {},
        hooks: {
          onTurnStart: [
            s.guard(s.defined(s.get(s.actor, "room"))),
            s.emit(s.damage(s.actor, s.lit(2))),
            s.emit(s.heal(s.actor, s.lit(1))),
            s.emit(s.grantImmunity(s.actor, s.lit(3))),
          ],
        },
      }),
    };

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-effects.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-effects.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-effects.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Genesis = { campaign: { started: boolean }; characters: { id: string }[] };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (!g.characters.find((c) => c.id === "player:Ada")) throw new Error("genesis must seat player:Ada");

    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      behaviors: Record<string, { script: { hooks?: { onTurnStart?: { effect?: { kind: string } }[] } } }>;
    };
    const body = catalog.behaviors[MECH_KEY]?.script.hooks?.onTurnStart ?? [];
    const kinds = body.map((st) => st.effect?.kind).filter(Boolean);
    for (const want of ["damage", "heal", "grantImmunity"]) {
      if (!kinds.includes(want)) throw new Error(`hex onTurnStart must emit ${want}`);
    }
  });
});
