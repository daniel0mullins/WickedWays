/**
 * g2-equipment oracle fixture — the TS twin for the G2 "full item descriptor"
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Authors THREE real hollow-house items proving every previously-hardcoded item
 * descriptor field:
 *   • Brass Lantern — `type: weapon`, `slot: hand`, `emitsLight: true`, `equippable`
 *   • Iron Fire-Poker — `slot: hand`, `maxDurability: 8`, `modifier: 5`, `equippable`
 *   • Water-Stained Journal — `lore: <JOURNAL_LORE>`, `droppable: false` (the win item)
 *
 * The native item factories are the differential-gate oracle; `catalogFromRegistry`
 * exports their descriptors, and the TOML `[[items]]` must reproduce them byte-for-byte.
 *
 * Writes g2-equipment.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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
import { lantern, poker, journal } from "../../packages/campaigns/src/hollow-house/items.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_e9; // "g2eq"; no rng draws in this pristine pre-begin genesis.

describe("generate g2-equipment oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // Native registry twins — the REAL item factories; catalogFromRegistry exports
    // their descriptors (the byte-parity target the TOML `[[items]]` must reproduce).
    const registry = defineRegistry({
      items: { lantern, poker, journal },
    });

    const template = authorTemplate("Equipment", registry, { rng })
      .room("Hall", { description: "A long central hall." })
      .startRoom("Hall")
      .loot("shelf", { room: "Hall", items: ["lantern", "poker", "journal"] });

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-equipment.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-equipment.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-equipment.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: each descriptor field survived ──────────────────────────
    type Desc = {
      type: string; modifier: number; slot?: string; emitsLight?: boolean;
      maxDurability?: number; lore?: string; properties: { equippable: boolean; droppable?: boolean };
    };
    const items = (catalogFromRegistry(registry, {}, {}, {}) as unknown as { items: Record<string, Desc> }).items;
    if (items.lantern?.slot !== "hand" || items.lantern?.emitsLight !== true || !items.lantern?.properties.equippable) {
      throw new Error("lantern descriptor wrong (slot/emitsLight/equippable)");
    }
    if (items.poker?.maxDurability !== 8 || items.poker?.modifier !== 5 || items.poker?.slot !== "hand") {
      throw new Error("poker descriptor wrong (maxDurability/modifier/slot)");
    }
    if (!items.journal?.lore || items.journal?.properties.droppable !== false) {
      throw new Error("journal descriptor wrong (lore/droppable)");
    }
  });
});
