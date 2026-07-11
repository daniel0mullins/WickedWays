/**
 * g2-mechanic-actions oracle fixture — the TS twin for the G2 "mechanic actions +
 * modifyDamage" author slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-mechanic-actions-design.md,
 * "The differential gate"). It runs the PROVEN TS builders to emit the committed
 * byte-parity TARGETS the Rust TOML author must reproduce node-for-node:
 *   • g2-mechanic-actions.description.json — the assembler INPUT (one room; a single
 *     `[[mechanics]]` opt-in → `description.mechanics = [{ key: "dread" }]`),
 *   • g2-mechanic-actions.catalog.json     — the DSL `behaviors` map carrying the
 *     mechanic's `BehaviorScript::Mechanic` (`init` + an `onTurnStart` hook + a
 *     `modifyDamage` transform + a custom `brace` action),
 *   • g2-mechanic-actions.genesis.json     — the pre-begin genesis `assemble` reproduces
 *     (`campaign.mechanics = [{ key: "dread", state: {} }]`, `state` = `init`).
 *
 * DUAL ENCODING (every conformance fixture's shape): the mechanic is authored for the
 * SAME key `dread` —
 *   • a native `Mechanic` (this fixture's `dreadWithBrace`) in the REGISTRY, whose
 *     `initialState: () => ({})` seeds the genesis mechanic state and whose
 *     onTurnStart/modifyDamage/brace closures are the runtime oracle, AND
 *   • the matching `s.mechanic(...)` DSL `BehaviorScript::Mechanic` in
 *     `catalog.behaviors.dread` — the Rust core interprets this, and it is the
 *     byte-parity TARGET the TOML compiler lowers `[behaviors.mechanic.dread]` to.
 * Real campaigns are TOML-only; this oracle twin is the reference.
 *
 * SLICE FOCUS: the two fields the #62 "mechanic scaffolding" slice deliberately
 * stubbed —
 *   • `modifyDamage` — the conformance dread's damage cap: `damage.amount > 3 ?
 *     final 3 : damage.amount` (the `damage` subject + `.amount` read + a `final`
 *     halting branch, exercised through the new `DamageBody` grammar), and
 *   • `actions.brace` — a budgeted custom action emitting a cue then +1 Sanity.
 * The `onTurnStart` hook (guard/not/hasEquipped/adjustStat + the `-1` literal) rides
 * along to prove hooks still lower unchanged beside the new fields. ASCII only.
 *
 * Writes g2-mechanic-actions.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { mulberry32 } from "../seeded-rng.ts";
import type { Mechanic } from "wickedways/lib/mechanics/mechanic";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62ac; // "g2ac"; no rng draws in this pristine pre-begin genesis.

// The shared key the mechanic opt-in + its behavior are both filed under.
const MECH_KEY = "dread";

// Native registry twin — the runtime oracle. `initialState` ({}) seeds the genesis
// state; the onTurnStart/modifyDamage/brace closures mirror the DSL twin below (they
// never fire in this pre-begin capture, but pin the intended behavior so the two
// twins cannot drift). `modifyDamage` caps at 3 (halting); `brace` is a budgeted
// custom action (Cue then +1 Sanity).
const dreadWithBrace: Mechanic<Record<string, never>, void, "brace"> = {
  initialState: () => ({}),
  onTurnStart: (h) =>
    h.actor.hasEquipped("lantern")
      ? []
      : [{ kind: "adjustStat", target: h.actor.id, stat: "sanity", delta: -1 }],
  modifyDamage: (d) => (d.amount > 3 ? { value: 3, final: true } : d.amount),
  actions: {
    brace: {
      run: (h) => [
        { kind: "cue", cue: { text: "You brace against the dread." } },
        { kind: "adjustStat", target: h.actor.id, stat: "sanity", delta: 1 },
      ],
    },
  },
};

describe("generate g2-mechanic-actions oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twin. `assemble` validates the `.useMechanic` opt-in and
    //     seeds the genesis mechanic state from `initialState()` ({}).
    const registry = defineRegistry({
      items: {},
      mechanics: { [MECH_KEY]: dreadWithBrace },
    });

    const template = authorTemplate("Mechanic Actions", registry, { rng })
      .room("Hall", { description: "A lightless hall where dread gathers." })
      .startRoom("Hall")
      .useMechanic(MECH_KEY);

    // (b) DSL behavior twin — interpreted by the Rust core; the byte-parity target.
    //     onTurnStart: no lantern -> drain 1 Sanity. modifyDamage: cap at 3 (final).
    //     brace action: cue then +1 Sanity.
    const behaviors = {
      [MECH_KEY]: s.mechanic({
        init: {},
        hooks: {
          onTurnStart: [
            s.guard(s.not(s.hasEquipped(s.actor, "lantern"))),
            s.emit(s.adjustStat(s.actor, "sanity", s.lit(-1))),
          ],
          modifyDamage: s.dmgIf(
            s.gt(s.get(s.damageSubject, "amount"), s.lit(3)),
            s.dmgFinal(s.lit(3)),
            s.dmgValue(s.get(s.damageSubject, "amount")),
          ),
        },
        actions: {
          brace: [
            s.emit(s.cue(s.lit("You brace against the dread."))),
            s.emit(s.adjustStat(s.actor, "sanity", s.lit(1))),
          ],
        },
      }),
    };

    // Boot the single-PC (player:Ada, NO archetype — this surface declares none)
    // pre-begin oracle. `OracleSession` captures the pristine genesis the Rust
    // assembler must reproduce from description + catalog.
    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-mechanic-actions.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-mechanic-actions.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-mechanic-actions.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the pre-begin oracle matches the mechanic surface ───────
    type Char = { id: string };
    type Genesis = {
      campaign: { started: boolean; mechanics?: { key: string; state: unknown }[] };
      rooms: unknown[];
      characters: Char[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 1) throw new Error(`expected 1 room, got ${g.rooms.length}`);
    if (!g.characters.find((c) => c.id === "player:Ada")) throw new Error("genesis must seat player:Ada");
    const dreadState = (g.campaign.mechanics ?? []).find((m) => m.key === MECH_KEY);
    if (!dreadState) throw new Error(`genesis must carry the ${MECH_KEY} mechanic state`);
    if (JSON.stringify(dreadState.state) !== "{}") {
      throw new Error(`${MECH_KEY} state must seed {} (init), got ${JSON.stringify(dreadState.state)}`);
    }

    // The catalog behavior is the Task-level byte-parity target: assert it carries
    // BOTH new fields (a non-empty `actions.brace` + a `modifyDamage` transform).
    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      behaviors: Record<
        string,
        { family: string; script: { actions?: Record<string, unknown>; hooks?: { modifyDamage?: unknown } } }
      >;
    };
    const behavior = catalog.behaviors[MECH_KEY];
    if (behavior?.family !== "mechanic") throw new Error(`behaviors.${MECH_KEY} must be family "mechanic"`);
    if (!behavior.script.actions || behavior.script.actions.brace === undefined) {
      throw new Error("mechanic script must carry a `brace` custom action");
    }
    if (behavior.script.hooks?.modifyDamage === undefined) {
      throw new Error("mechanic script must carry a `modifyDamage` transform");
    }
  });
});
