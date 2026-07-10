import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonical } from "./canonical-json";

const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  roundtrip_snapshot: (json: string) => string;
};
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("World snapshot round-trip parity (Rust vs TS)", () => {
  for (const slug of ["seed", "hollow-house"]) {
    it(`round-trips the ${slug} genesis snapshot canonically`, () => {
      const input = readFileSync(join(fixturesDir, `${slug}.snapshot.json`), "utf8");
      const output = wasm.roundtrip_snapshot(input);
      expect(canonical(JSON.parse(output))).toBe(canonical(JSON.parse(input)));
    });
  }
});
