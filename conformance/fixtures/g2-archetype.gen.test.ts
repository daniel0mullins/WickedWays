/**
 * g2-archetype oracle fixture — the TS twin for the G2 "archetypes" description-surface
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Authors the REAL hollow-house `Heir` archetype and seats a PC as it, proving the Rust
 * TOML author reproduces `description.archetypes` (and the seated PC's statline/immunities
 * in the genesis) node-for-node.
 *
 * The Heir exercises every ArchetypeDef sub-field: `baseStats` (health/sanity/energy),
 * `inventorySlots` (a +1 delta on the base 5), and `immunities: ["fear"]`.
 *
 * Writes g2-archetype.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_a5; // "g2ar"; no rng draws in this pristine pre-begin genesis.

const HEIR = "heir";

describe("generate g2-archetype oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis (seated as Heir)", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });

    const template = authorTemplate("Archetype", registry, { rng })
      .archetype({
        id: HEIR,
        name: "Heir",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 16, [StatType.Energy]: 5 },
        inventorySlots: 1,
        immunities: [Status.Fear],
      })
      .room("Hall", { description: "A long central hall." })
      .startRoom("Hall");

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      archetype: HEIR,
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-archetype.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-archetype.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-archetype.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Arch = { id: string; name: string; baseStats?: Record<string, number>; inventorySlots?: number; immunities?: string[] };
    const desc = stripRng(template.description) as unknown as { archetypes: Arch[] };
    const a = desc.archetypes.find((x) => x.id === HEIR);
    if (!a) throw new Error("description must carry the heir archetype");
    if (a.name !== "Heir" || a.inventorySlots !== 1) throw new Error("heir name/inventorySlots wrong");
    if (!a.immunities?.includes("fear")) throw new Error("heir must be immune to fear");
    if (a.baseStats?.[StatType.Sanity] !== 16) throw new Error("heir sanity baseStat must be 16");

    type Genesis = { campaign: { started: boolean }; characters: { id: string; archetypeId?: string | null }[] };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    const pc = g.characters.find((c) => c.id === "player:Ada");
    if (!pc || pc.archetypeId !== HEIR) throw new Error("genesis PC must be seated as heir");
  });
});
