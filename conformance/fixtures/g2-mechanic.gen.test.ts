/**
 * g2-mechanic oracle fixture — the TS twin for the G2 "mechanic scaffolding"
 * author slice (docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-mechanic-design.md,
 * "The differential gate"). This runs the PROVEN TS builders to emit the committed
 * byte-parity TARGETS that the Rust TOML author (Task 4) must reproduce node-for-node:
 *   • g2-mechanic.description.json — the assembler's INPUT (one room; a single
 *     `[[mechanics]]` opt-in → `description.mechanics = [{ key: "dread" }]`),
 *   • g2-mechanic.catalog.json     — the DSL `behaviors` map carrying the mechanic's
 *     `BehaviorScript::Mechanic` (`init` + a single `onTurnStart` hook body),
 *   • g2-mechanic.genesis.json      — the pre-begin genesis `assemble` must reproduce
 *     (`campaign.mechanics = [{ key: "dread", state: {} }]`, `state` = `init`).
 *
 * DUAL ENCODING (every conformance fixture's shape): the dread mechanic is authored
 * for the SAME key `dread` —
 *   • the REAL Hollow House `dread` `Mechanic` (mechanics.ts) in the REGISTRY, whose
 *     `initialState: () => ({})` + `onTurnStart` closure is the differential-gate
 *     oracle; `.useMechanic("dread")` opts the campaign into it and `assemble` seeds
 *     the genesis mechanic state from `initialState()`, AND
 *   • the matching `s.mechanic(...)` DSL `BehaviorScript::Mechanic` in
 *     `catalog.behaviors.dread` — the Rust core interprets this, and it is the
 *     byte-parity TARGET the TOML compiler lowers `[behaviors.mechanic.dread]` to.
 * Real campaigns are TOML-only; this oracle twin is the reference.
 *
 * SLICE SUBSET: `init` is `{}` and there is exactly ONE hook (`onTurnStart`) whose
 * body is `[ guard !hasEquipped(actor, 'lantern'), emit adjustStat(actor, sanity, -1) ]`
 * — only guard/not/hasEquipped/adjustStat + the negative `-1` literal. No actions, no
 * modifyDamage, no other hooks/effects, no storyteller/status-bar forms.
 *
 * CANONICAL `actions:{}`: the TS `s.mechanic` builder always emits `actions: {}`
 * (the ts-rs binding marks it required, not `ts(optional)`), and Rust's
 * `MechanicScript.actions` is `#[serde(default)]` with NO `skip_serializing_if`, so
 * Rust likewise always serializes `actions` (even when empty). The committed catalog
 * therefore carries `actions: {}` — byte-faithful to both, matching the real
 * hollow-house mechanics. The hook body itself is built with the real `s.*` builders,
 * so it is the faithful DSL twin.
 *
 * Writes g2-mechanic.{description,catalog,genesis}.json. Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";
import { dread } from "../../packages/campaigns/src/hollow-house/mechanics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62; // "g2"; no rng draws in this pristine pre-begin genesis.

// The shared key the mechanic opt-in + its behavior are both filed under.
const MECH_KEY = "dread";

describe("generate g2-mechanic oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twin — the REAL Hollow House `dread` Mechanic. `assemble`
    //     validates the `.useMechanic` opt-in and seeds the genesis mechanic state
    //     from its `initialState()` ({}). The mechanic is opted-in (→ description),
    //     never fires here (pre-begin genesis is captured before beginCampaign).
    const registry = defineRegistry({
      items: {},
      mechanics: { [MECH_KEY]: dread },
    });

    const template = authorTemplate("Mechanic", registry, { rng })
      .room("Hall", { description: "A lightless hall where dread gathers." })
      .startRoom("Hall")
      .useMechanic(MECH_KEY);

    // (b) DSL behavior twin — interpreted by the Rust core; the byte-parity target.
    //     Reproduces the `dread` onTurnStart closure: if the actor has no lantern
    //     equipped, drain 1 Sanity. The `-1` delta is the negative `lit(-1)` literal.
    const behaviors = {
      [MECH_KEY]: s.mechanic({
        init: {},
        hooks: {
          onTurnStart: [
            s.guard(s.not(s.hasEquipped(s.actor, "lantern"))),
            s.emit(s.adjustStat(s.actor, "sanity", s.lit(-1))),
          ],
        },
      }),
    };

    // Boot the single-PC (player:Ada, NO archetype — this surface declares none)
    // pre-begin oracle. `OracleSession` captures the pristine genesis `Authority::new`
    // consumes (exactly what the Rust assembler must reproduce from description+catalog).
    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-mechanic.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-mechanic.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-mechanic.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the pre-begin oracle matches the mechanic surface ───────
    type Char = { id: string; archetypeId?: string | null };
    type Genesis = {
      campaign: { started: boolean; mechanics?: { key: string; state: unknown }[] };
      rooms: unknown[];
      characters: Char[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 1) throw new Error(`expected 1 room, got ${g.rooms.length}`);
    const pc = g.characters.find((c) => c.id === "player:Ada");
    if (!pc) throw new Error("genesis must seat player:Ada");
    const mechs = g.campaign.mechanics ?? [];
    const dreadState = mechs.find((m) => m.key === MECH_KEY);
    if (!dreadState) throw new Error(`genesis must carry the ${MECH_KEY} mechanic state`);
    if (JSON.stringify(dreadState.state) !== "{}") {
      throw new Error(`${MECH_KEY} state must seed {} (init), got ${JSON.stringify(dreadState.state)}`);
    }

    // The mechanic opt-in + mechanic behavior are the Task 4 byte-parity targets.
    const desc = stripRng(template.description) as unknown as { mechanics: { key: string }[] };
    if (desc.mechanics.length !== 1 || desc.mechanics[0]?.key !== MECH_KEY) {
      throw new Error(`description.mechanics must be [{ key: "${MECH_KEY}" }]`);
    }
    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      behaviors: Record<string, { family: string; script: { actions?: Record<string, unknown> } }>;
    };
    const behavior = catalog.behaviors[MECH_KEY];
    if (behavior?.family !== "mechanic") {
      throw new Error(`behaviors.${MECH_KEY} must be family "mechanic"`);
    }
    if (
      behavior.script.actions === undefined ||
      Object.keys(behavior.script.actions).length !== 0
    ) {
      throw new Error("mechanic script must carry canonical `actions: {}` (present, empty)");
    }
  });
});
