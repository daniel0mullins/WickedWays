import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "conformance/fixtures/generate-snapshots.test.ts",
      "conformance/fixtures/turn-movement.gen.test.ts",
      "conformance/fixtures/items-projection.gen.test.ts",
      "conformance/fixtures/items-actions.gen.test.ts",
      "conformance/fixtures/afflictions.gen.test.ts",
      "conformance/fixtures/combat.gen.test.ts",
      "conformance/fixtures/mob-defeat.gen.test.ts",
    ],
    environment: "node",
  },
});
