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
import { hauntedHouseTemplate } from "../../packages/campaigns/src/hollow-house/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("fixture generation", () => {
  it("writes seed.snapshot.json", () => {
    const snapshot = seedTemplate().toSnapshot();
    writeFileSync(
      join(here, "seed.snapshot.json"),
      JSON.stringify(snapshot, null, 2),
    );
  });

  it("writes hollow-house.snapshot.json", () => {
    const snapshot = hauntedHouseTemplate().toSnapshot();
    writeFileSync(
      join(here, "hollow-house.snapshot.json"),
      JSON.stringify(snapshot, null, 2),
    );
  });
});
