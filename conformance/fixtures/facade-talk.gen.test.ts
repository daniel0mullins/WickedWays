/**
 * facade-talk golden — the talk rejection AND the startup-cues fixture.
 *
 * `talk` is a FREE (non-advancing) interaction, and this campaign has no NPC to
 * talk to, so dispatch throws "There's no one here to talk to." Because talk is
 * free, startTurn does NOT run (no dread onTurnStart cue) and nextPlayer does NOT
 * run (round stays 0); the error path returns { cues: [], error } with NO
 * mobAttacks key.
 *
 * The dread shadow is enabled so beginCampaign buffers a round-0 onRoundStart
 * cue ("Dread stirs.") → golden.startupCues is non-empty → replayFacade proves
 * take_startup_cues parity (the core-begins lifecycle, end-to-end).
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { DREAD_KEY, dreadShadow } from "./dread-shadow.ts";
import { mechanic } from "../../packages/campaigns/src/scripted/builders.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade5;

// `conformance:dread` catalog twin. The campaign opts into the mechanic
// (`.useMechanic(DREAD_KEY)`), so the description references it and the Rust
// assembler's validate throws UnregisteredMechanic unless it is in the catalog
// behaviors. At RUNTIME the Rust core resolves `conformance:dread` NATIVELY
// (conformance.rs; native resolution WINS over a same-key catalog behavior), so
// these hooks are never executed — this entry exists solely so the assembler can
// validate the key and read `script.init` for the genesis mechanic state, which
// must equal `dreadShadow.initialState()` ({ ticks: 0 }).
const dreadCatalogTwin = mechanic({ init: dreadShadow.initialState() });
const CATALOG = { items: {}, aliases: {}, behaviors: { [DREAD_KEY]: dreadCatalogTwin } };

describe("generate facade-talk golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {}, mechanics: { [DREAD_KEY]: dreadShadow } });
    const template = authorTemplate("Facade Talk (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .useMechanic(DREAD_KEY);

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "talk", npcId: "anyone" } }, // free throw: no startTurn, no nextPlayer (round stays 0)
      { kind: "submit", intent: { kind: "wait" } },                   // advancing no-op: nextPlayer wraps round 0 → 1
    ];
    const steps = writeFacadeFixture(here, "facade-talk", SEED, oracle, CATALOG, ops, template.description);

    // The boot must have buffered round-0 cues so take_startup_cues has parity to prove.
    if (oracle.startupCues.length === 0) {
      throw new Error("expected dread to buffer startup cues at boot");
    }
    const r0 = steps[0]!.result as { error?: string; mobAttacks?: unknown };
    if (r0.error !== "There's no one here to talk to.") {
      throw new Error(`step 0 expected talk error, got ${JSON.stringify(r0)}`);
    }
    if ("mobAttacks" in r0) throw new Error("error path must omit mobAttacks");
    // talk is FREE: neither startTurn nor nextPlayer ran (round still 0); the
    // following advancing wait wraps to round 1.
    const s0 = steps[0]!.snapshot as { campaign: { round: number } };
    const s1 = steps[1]!.snapshot as { campaign: { round: number } };
    if (s0.campaign.round !== 0) throw new Error(`step 0 round expected 0, got ${s0.campaign.round}`);
    if (s1.campaign.round !== 1) throw new Error(`step 1 round expected 1, got ${s1.campaign.round}`);
  });
});
