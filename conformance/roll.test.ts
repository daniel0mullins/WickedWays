import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { roll as rollTs } from "../src/lib/dice";
import { mulberry32 } from "./seeded-rng";

// The wasm-pack --target nodejs output is CommonJS. Use createRequire so this
// ESM test file can load it without import() round-tripping through dynamic
// evaluation, which avoids async-import complications in vitest.
const require = createRequire(import.meta.url);
const { roll: rollWasm } = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js");

describe("roll parity (Rust vs TS)", () => {
  it("is identical across 50k seeded samples and many die sizes", () => {
    const rng = mulberry32(0x5eed);
    const sizes = [2, 4, 6, 8, 10, 12, 20, 100];
    for (let i = 0; i < 50_000; i++) {
      const unit = rng();
      const sides = sizes[i % sizes.length]!;
      const ts = rollTs(sides, () => unit);
      const rs = rollWasm(sides, unit);
      if (ts !== rs) {
        throw new Error(`divergence at i=${i}: sides=${sides} unit=${unit} ts=${ts} rs=${rs}`);
      }
      expect(rs).toBe(ts);
    }
  });
});
