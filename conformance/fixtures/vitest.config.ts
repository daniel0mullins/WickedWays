import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "conformance/fixtures/generate-snapshots.test.ts",
      "conformance/fixtures/turn-movement.gen.test.ts",
      "conformance/fixtures/items-projection.gen.test.ts",
    ],
    environment: "node",
  },
});
