/**
 * g2-formations oracle fixture — the TS twin for the G2 "formations" slice
 * (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * The biggest description-surface slice: it spans BOTH halves of a data-driven
 * encounter formation — the description-side weighted opt-ins (`FormationDef`) and
 * the catalog-side `FormationDescriptor`s (the `MobSpec` roster). Authors the REAL
 * hollow-house roving rats (`rat-single` weight 3, `rat-pair` weight 1) over the real
 * `ratTail` drop item.
 *
 * Writes g2-formations.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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
import { ratTail } from "../../packages/campaigns/src/hollow-house/items.ts";
import { hollowHouseFormations } from "../../packages/campaigns/src/hollow-house/index.ts";
import { descriptorToFormation } from "../../packages/campaigns/src/formations.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_f0; // "g2fo"; no rng draws in this pristine pre-begin genesis.

const FORMATIONS = hollowHouseFormations();
// The MobSpec numeric fields are bigints (baseEscapeChance 50n, actionsPerRound 2n);
// coerce them to JSON numbers so serde reads them (mirrors formation-descriptor.gen).
const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

describe("generate g2-formations oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);
    // The formation mob drops rat-tail (a registered item); the opt-ins reference
    // registered formation behaviors (built from the real descriptors).
    const registry = defineRegistry({ items: { "rat-tail": ratTail } });
    registry.registerFormation("rat-single", descriptorToFormation(FORMATIONS["rat-single"]!, registry));
    registry.registerFormation("rat-pair", descriptorToFormation(FORMATIONS["rat-pair"]!, registry));

    const template = authorTemplate("Formations", registry, { rng })
      .room("Hall", { description: "A long central hall." })
      .startRoom("Hall")
      .formation("rat-single", { weight: 3 })
      .formation("rat-pair", { weight: 1 });

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-formations.description.json"),
      JSON.stringify(stripRng(template.description), bigintReplacer, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-formations.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, {}, {}, FORMATIONS), bigintReplacer, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-formations.genesis.json"),
      JSON.stringify(oracle.genesis, bigintReplacer, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Formation = { key: string; weight?: number };
    const desc = stripRng(template.description) as unknown as { formations: Formation[] };
    const single = desc.formations.find((f) => f.key === "rat-single");
    const pair = desc.formations.find((f) => f.key === "rat-pair");
    if (single?.weight !== 3 || pair?.weight !== 1) throw new Error("formation opt-in weights wrong");

    const cat = catalogFromRegistry(registry, {}, {}, FORMATIONS) as unknown as {
      formations: Record<string, { mobs: { name: string }[] }>;
    };
    if (cat.formations["rat-single"]?.mobs.length !== 1 || cat.formations["rat-pair"]?.mobs.length !== 2) {
      throw new Error("formation descriptor mob rosters wrong");
    }
  });
});
