import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { MitigatorStatType, StatType } from "../src/lib/character/stats";

// The wasm-pack --target nodejs output is CommonJS. Use createRequire so this
// ESM test file can load it without import() round-tripping through dynamic
// evaluation, which avoids async-import complications in vitest.
const require = createRequire(import.meta.url);
const { mitigator: mitigatorWasm } = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js");

describe("StatType.mitigator parity (Rust vs TS)", () => {
  it("matches MitigatorStatType for every stat", () => {
    for (const stat of Object.values(StatType)) {
      expect(mitigatorWasm(stat)).toBe(MitigatorStatType[stat]);
    }
  });
});
