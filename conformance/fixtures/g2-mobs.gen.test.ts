/**
 * g2-mobs oracle fixture — the TS twin for the G2 "placed mobs" description-surface
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Authors the TWO real hollow-house mobs (Wraith, Revenant), proving the Rust TOML
 * author reproduces `description.mobs` node-for-node: name, stats, room, drops, and
 * the `{stat, power}` naturalAttack. The mob rooms are connected to the start room so
 * the TS assemble doesn't prune them.
 *
 * Writes g2-mobs.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import { brassKey, ironKey } from "../../packages/campaigns/src/hollow-house/items.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_45; // "g2mb"; no rng draws in this pristine pre-begin genesis.

describe("generate g2-mobs oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);
    // The dropped keys must be registered items (assemble validates mob drops).
    const registry = defineRegistry({ items: { "brass-key": brassKey, "iron-key": ironKey } });

    const template = authorTemplate("Mobs", registry, { rng })
      .room("Hall", { description: "A long central hall." })
      .room("Nursery", { description: "A child's room, long abandoned." })
      .room("Cellar", { description: "The cellar below." })
      .startRoom("Hall")
      .exit("Hall", Directions.North, "Nursery")
      .exit("Hall", Directions.South, "Cellar")
      // The two real hollow-house mobs: Wraith drops the brass key, Revenant the iron.
      .mob("Wraith", {
        stats: { [StatType.Health]: 6, [StatType.Sanity]: 5, [StatType.Energy]: 5 },
        room: "Nursery",
        drops: ["brass-key"],
        naturalAttack: { stat: StatType.Sanity, power: 3 },
      })
      .mob("Revenant", {
        stats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 6 },
        room: "Cellar",
        drops: ["iron-key"],
        naturalAttack: { stat: StatType.Sanity, power: 2 },
      });

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-mobs.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-mobs.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-mobs.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Mob = { name: string; room?: string; drops?: string[]; naturalAttack?: { stat: string; power: number } };
    const desc = stripRng(template.description) as unknown as { mobs: Mob[] };
    const wraith = desc.mobs.find((m) => m.name === "Wraith");
    const revenant = desc.mobs.find((m) => m.name === "Revenant");
    if (!wraith || !revenant) throw new Error("both mobs must be present");
    if (wraith.room !== "Nursery" || wraith.drops?.[0] !== "brass-key" || wraith.naturalAttack?.power !== 3) {
      throw new Error("Wraith fields wrong");
    }
    if (revenant.naturalAttack?.stat !== "sanity" || revenant.naturalAttack?.power !== 2) {
      throw new Error("Revenant naturalAttack wrong");
    }
  });
});
