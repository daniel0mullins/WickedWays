/**
 * Fixture generator — run once to write the *.snapshot.json files committed to
 * the repo. Uses vitest as the TS runner (tsx is not in this repo's dev-deps).
 *
 * Run with:
 *   vitest run --config conformance/vitest.config.ts conformance/fixtures/generate-snapshots.test.ts
 *
 * Or via the fixtures:gen script:
 *   pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { seedTemplate } from "../../packages/seed/src/index.ts";
import {
  hauntedHouseTemplate,
  ALIASES,
  hollowHouseBehaviors,
  hollowHouseFormations,
} from "../../packages/campaigns/src/hollow-house/index.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Formation descriptors carry `i64` fields as `bigint` (baseEscapeChance,
// actionsPerRound); JSON.stringify throws on bigint. Coerce to Number so serde
// reads them as JSON integers — mirrors play-runtime's session.ts, so the live
// catalog matches the golden byte-for-byte.
function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}

describe("fixture generation", () => {
  it("writes seed.snapshot.json + description + catalog", () => {
    const builder = seedTemplate();
    writeFileSync(
      join(here, "seed.snapshot.json"),
      JSON.stringify(builder.toSnapshot(), null, 2) + "\n",
    );
    // The description is the assembler's INPUT artifact; the snapshot/genesis is
    // its output. Emitting both lets the Rust assembler be gated against the
    // committed goldens beside them.
    writeFileSync(
      join(here, "seed.description.json"),
      JSON.stringify(stripRng(builder.description), null, 2) + "\n",
    );
    // The gate needs the catalog too: it is `assemble`'s second input. The seed
    // campaign carries no aliases/behaviors/formations, so all three are empty.
    writeFileSync(
      join(here, "seed.catalog.json"),
      JSON.stringify(
        catalogFromRegistry(builder.registry, /* aliases */ {}, {}, {}),
        bigintReplacer,
        2,
      ) + "\n",
    );
  });

  it("writes hollow-house.snapshot.json + description + catalog", () => {
    const builder = hauntedHouseTemplate();
    writeFileSync(
      join(here, "hollow-house.snapshot.json"),
      JSON.stringify(builder.toSnapshot(), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "hollow-house.description.json"),
      JSON.stringify(stripRng(builder.description), null, 2) + "\n",
    );
    // Match the live engine catalog byte-for-byte: GameSession.start boots
    // hollow-house with ALIASES + hollowHouseBehaviors() + hollowHouseFormations()
    // (see packages/play/src/core/capstone.test.ts and session.ts).
    writeFileSync(
      join(here, "hollow-house.catalog.json"),
      JSON.stringify(
        catalogFromRegistry(
          builder.registry,
          ALIASES,
          hollowHouseBehaviors(),
          hollowHouseFormations(),
        ),
        bigintReplacer,
        2,
      ) + "\n",
    );
  });
});
