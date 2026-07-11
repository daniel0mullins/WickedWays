/**
 * g2-opts oracle fixture — the TS twin for the G2 "campaign opts" slice
 * (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Proves the Rust TOML author carries the campaign `[opts]` (previously hardcoded to
 * the default): the real hollow-house bounds `maxRounds: 150` + `baseEncounterChance: 20`.
 *
 * Writes g2-opts.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_09; // "g2op"; no rng draws in this pristine pre-begin genesis.

describe("generate g2-opts oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });

    const template = authorTemplate("Opts", registry, { rng, maxRounds: 150, baseEncounterChance: 20 })
      .room("Hall", { description: "A long central hall." })
      .startRoom("Hall");

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-opts.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-opts.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-opts.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    const desc = stripRng(template.description) as unknown as {
      opts: { maxRounds?: number; baseEncounterChance?: number };
    };
    if (desc.opts?.maxRounds !== 150) throw new Error("opts.maxRounds must be 150");
    if (desc.opts?.baseEncounterChance !== 20) throw new Error("opts.baseEncounterChance must be 20");
  });
});
