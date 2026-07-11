/**
 * g2-storyteller oracle fixture — the TS twin for the G2 "storyteller forms" author
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-expression-surface-design.md).
 * It authors the REAL hollow-house `storyteller` mechanic (over a small 1-entry lore
 * map) and proves the Rust TOML author reproduces its `onAction` body node-for-node.
 *
 * This is the single most-cited deferred bundle: the `action` subject, `mapLit`,
 * `has`, `lookup`, `stateGetIn`, and the `setStateIn` statement — every form the
 * storyteller's guard chain needs beyond what earlier slices shipped
 * (`hasItem`/`not`/`guard`/`cue`/`eq` already work).
 *
 * DUAL ENCODING: the mechanic is authored TWICE for the key `storyteller` — the real
 * `makeStoryteller(lore)` `Mechanic` in the REGISTRY (its `initialState: () => ({ seen:
 * {} })` seeds the genesis state) and the matching `storytellerScript(lore)` DSL twin
 * in `catalog.behaviors` (the byte-parity TARGET the compiler lowers to). Real
 * campaigns are TOML-only; this oracle twin is the reference.
 *
 * Writes g2-storyteller.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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
import { makeStoryteller } from "../../packages/campaigns/src/hollow-house/mechanics.ts";
import { storytellerScript } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x6273; // "g2st"; no rng draws in this pristine pre-begin genesis.

const MECH_KEY = "storyteller";
// A minimal 1-entry lore map — keeps the inline `mapLit(...)` short while exercising
// every storyteller form. Shared by BOTH twins so their ASTs agree byte-for-byte.
const LORE: Record<string, string> = { Parlor: "A mildewed parlor." };

describe("generate g2-storyteller oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    const registry = defineRegistry({
      items: {},
      mechanics: { [MECH_KEY]: makeStoryteller(LORE) },
    });

    const template = authorTemplate("Storyteller", registry, { rng })
      .room("Parlor", { description: "A mildewed parlor." })
      .startRoom("Parlor")
      .useMechanic(MECH_KEY);

    // DSL behavior twin — the real storyteller onAction guard chain over LORE.
    const behaviors = { [MECH_KEY]: storytellerScript(LORE) };

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-storyteller.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-storyteller.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-storyteller.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Genesis = {
      campaign: { started: boolean; mechanics?: { key: string; state: unknown }[] };
      characters: { id: string }[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (!g.characters.find((c) => c.id === "player:Ada")) throw new Error("genesis must seat player:Ada");
    const state = (g.campaign.mechanics ?? []).find((m) => m.key === MECH_KEY)?.state;
    if (JSON.stringify(state) !== JSON.stringify({ seen: {} })) {
      throw new Error(`${MECH_KEY} state must seed { seen: {} }, got ${JSON.stringify(state)}`);
    }

    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      behaviors: Record<string, { script: { hooks?: { onAction?: { kind: string }[] } } }>;
    };
    const body = catalog.behaviors[MECH_KEY]?.script.hooks?.onAction ?? [];
    if (!body.some((st) => st.kind === "setStateIn")) {
      throw new Error("storyteller onAction must carry a setStateIn statement");
    }
  });
});
