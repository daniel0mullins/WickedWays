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
      "conformance/fixtures/mob-drop.gen.test.ts",
      "conformance/fixtures/material-drop.gen.test.ts",
      "conformance/fixtures/mechanics.gen.test.ts",
      "conformance/fixtures/mechanics-turnend.gen.test.ts",
      "conformance/fixtures/mechanics-action.gen.test.ts",
      "conformance/fixtures/keyed-exit.gen.test.ts",
      "conformance/fixtures/scene.gen.test.ts",
      "conformance/fixtures/spawn.gen.test.ts",
      "conformance/fixtures/sees-in-dark.gen.test.ts",
      "conformance/fixtures/victory-won.gen.test.ts",
      "conformance/fixtures/victory-lost.gen.test.ts",
      "conformance/fixtures/victory-timeout.gen.test.ts",
      "conformance/fixtures/victory-ended.gen.test.ts",
    ],
    environment: "node",
  },
});
