import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["conformance/fixtures/generate-snapshots.test.ts"],
    environment: "node",
  },
});
