/**
 * g2-timeout oracle fixture — the TS twin for the G2 "timeout narration" slice
 * (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Proves the Rust TOML author carries `description.timeout_narration` (previously
 * hardcoded `None`): the real hollow-house `.onTimeout(...)` cue, authored as a plain
 * `timeoutNarration` string that lowers to the `{ text }` shape.
 *
 * Writes g2-timeout.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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
const SEED = 0x62_10; // "g2ti"; no rng draws in this pristine pre-begin genesis.

// The exact real hollow-house timeout narration (index.ts .onTimeout).
const TIMEOUT =
  "Dawn never comes. You realize, slowly, that it never will — and that you stopped looking for the door some hours ago.";

describe("generate g2-timeout oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });

    const template = authorTemplate("Timeout", registry, { rng })
      .room("Hall", { description: "A long central hall." })
      .startRoom("Hall")
      .onTimeout({ text: TIMEOUT });

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors: {},
    });

    writeFileSync(
      join(here, "g2-timeout.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-timeout.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-timeout.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    const desc = stripRng(template.description) as unknown as { timeoutNarration?: { text: string } };
    if (desc.timeoutNarration?.text !== TIMEOUT) throw new Error("timeout narration text mismatch");
  });
});
