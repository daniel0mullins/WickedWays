import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["conformance/**/*.test.ts"],
    environment: "node",
  },
});
