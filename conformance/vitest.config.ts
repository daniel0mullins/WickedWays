import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["conformance/**/*.test.ts"],
    exclude: ["conformance/fixtures/**"],
    environment: "node",
  },
});
