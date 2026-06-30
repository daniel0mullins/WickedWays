import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { computeMitigatedDamage, type DamageInput } from "../src/lib/character/damage";
import { mulberry32 } from "./seeded-rng";

// The wasm-pack --target nodejs output is CommonJS. Use createRequire so this
// ESM test file can load it without import() round-tripping through dynamic
// evaluation, which avoids async-import complications in vitest.
const require = createRequire(import.meta.url);
const { mitigated_damage: mitigatedWasm } = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js");

describe("computeMitigatedDamage parity (Rust vs TS)", () => {
  it("is float-exact across 100k seeded inputs", () => {
    const rng = mulberry32(0xda4a);
    for (let i = 0; i < 100_000; i++) {
      const input: DamageInput = {
        attackStrength: rng() * 1000,
        armorSum: rng() * 1000,
        mitigator: rng() * 20,
        lightAverse: rng() < 0.5,
        roomLit: rng() < 0.5,
      };
      const ts = computeMitigatedDamage(input);
      const rs = mitigatedWasm(input);
      if (!Object.is(ts, rs)) {
        throw new Error(`divergence at i=${i}: ${JSON.stringify(input)} ts=${ts} rs=${rs}`);
      }
      expect(Object.is(ts, rs)).toBe(true);
    }
  });
});
