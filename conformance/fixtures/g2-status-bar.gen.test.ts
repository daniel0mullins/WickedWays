/**
 * g2-status-bar oracle fixture — the TS twin for the G2 "status-bar forms" author
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-status-bar-design.md).
 * It authors the REAL hollow-house `status-bar` mechanic and proves the Rust TOML
 * author reproduces its `onRoundStart`/`onTurnEnd` bodies node-for-node.
 *
 * Exercises this slice's forms: `str`, `concat`, `length`, `first`, and the `Status`
 * effect with its `field(label, value[, emphasis])` sub-grammar (`FieldTemplate`).
 * The emphasis ladder reuses the already-shipped ternary + `<=` + `get`.
 *
 * DUAL ENCODING: the mechanic is authored TWICE for the key `status-bar` — the real
 * `statusBar` `Mechanic` in the REGISTRY (its `initialState: () => ({})` seeds the
 * genesis state) and the matching `statusBarScript` DSL twin in `catalog.behaviors`
 * (the byte-parity TARGET). Real campaigns are TOML-only; this oracle twin is the
 * reference.
 *
 * Writes g2-status-bar.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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
import { statusBar } from "../../packages/campaigns/src/hollow-house/status.ts";
import { statusBarScript } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_5b; // "g2sb"; no rng draws in this pristine pre-begin genesis.

const MECH_KEY = "status-bar";

describe("generate g2-status-bar oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    const registry = defineRegistry({
      items: {},
      mechanics: { [MECH_KEY]: statusBar },
    });

    const template = authorTemplate("Status Bar", registry, { rng })
      .room("Hall", { description: "A cold stone hall." })
      .startRoom("Hall")
      .useMechanic(MECH_KEY);

    const behaviors = { [MECH_KEY]: statusBarScript };

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-status-bar.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-status-bar.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-status-bar.genesis.json"),
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
    if (JSON.stringify(state) !== "{}") {
      throw new Error(`${MECH_KEY} state must seed {}, got ${JSON.stringify(state)}`);
    }

    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      behaviors: Record<string, { script: { hooks?: { onTurnEnd?: { effect?: { kind: string } }[] } } }>;
    };
    const onTurnEnd = catalog.behaviors[MECH_KEY]?.script.hooks?.onTurnEnd ?? [];
    if (!onTurnEnd.some((st) => st.effect?.kind === "status")) {
      throw new Error("status-bar onTurnEnd must emit a status effect");
    }
  });
});
