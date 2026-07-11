/**
 * g2-dark-rooms oracle fixture — the TS twin for the G2 "room dark + spawnModifier"
 * description-surface slice
 * (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Proves the Rust TOML author carries the room sub-fields it previously dropped:
 * `dark` (a lightless Cellar, per the real hollow-house) and `spawnModifier` (a
 * biased-encounter Hall). Rooms are connected so neither is pruned.
 *
 * Writes g2-dark-rooms.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Directions } from "wickedways/lib/room";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_dc; // "g2dk"; no rng draws in this pristine pre-begin genesis.

describe("generate g2-dark-rooms oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });

    const template = authorTemplate("Dark Rooms", registry, { rng })
      .room("Hall", { description: "A long central hall.", spawnModifier: 1 })
      .room("Cellar", { description: "The cellar below.", dark: true })
      .startRoom("Hall")
      .exit("Hall", Directions.South, "Cellar");

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-dark-rooms.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-dark-rooms.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-dark-rooms.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Room = { name: string; dark?: boolean; spawnModifier?: number };
    const desc = stripRng(template.description) as unknown as { rooms: Room[] };
    const hall = desc.rooms.find((r) => r.name === "Hall");
    const cellar = desc.rooms.find((r) => r.name === "Cellar");
    if (hall?.spawnModifier !== 1) throw new Error("Hall must carry spawnModifier 1");
    if (cellar?.dark !== true) throw new Error("Cellar must be dark");
  });
});
