# Rust Engine Core — Phase 0 (Toolchain & Pure-Leaf Math) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Rust→WASM toolchain, the Rust→TS type-generation pipeline, and a deterministic differential-testing harness, then port three pure-leaf engine functions (`roll`, the stat-mitigator cycle, the damage-mitigation formula) and prove they are byte-identical to the TypeScript originals.

**Architecture:** A new Cargo workspace at the repo root holds `wickedways-core` (pure, `no_std`-friendly engine logic + serde boundary types) and `wickedways-wasm` (the `wasm-bindgen`/`serde-wasm-bindgen` binding layer + `ts-rs` export). A `conformance/` suite (vitest) loads the WASM build in Node and diffs Rust output against the existing TS engine over seeded random inputs. Phase 0 ships no behavior change to the running engine — it is pure de-risking of the toolchain everything downstream depends on.

**Tech Stack:** Rust (edition 2021), `cargo`, `rustup`, `wasm-pack` (`--target nodejs`), `wasm-bindgen` 0.2, `serde` 1 / `serde-wasm-bindgen` 0.6, `ts-rs` 10, `proptest` 1; TypeScript, `pnpm` 9.15.6, `vitest` 4.

## Global Constraints

These apply to **every** task; each task's requirements implicitly include this section.

- **Invariant 1 — one source of truth for typings.** Every boundary type (here: `StatType`, `DamageInput`) is defined **once in Rust** and its TypeScript form is **generated** via `ts-rs`. Never hand-author the generated `.ts`.
- **Invariant 3 — determinism.** Differential checks assert **exact** equality (`===`, including float bit-equality via `Object.is`), never approximate/`toBeCloseTo`. Any divergence is a Phase 0 blocker to investigate, not a tolerance to widen.
- **Invariant 5 — `no_std`-friendly core.** `wickedways-core` compiles under `no_std`; `std`, the `ts` (ts-rs) integration, and (later) scripting live behind cargo features. `serde` is pulled with `default-features = false, features = ["derive", "alloc"]`.
- **Invariant 7 — generated bindings are build artifacts.** A CI step regenerates the bindings and fails on any git diff.
- **Rust edition is `2021`.** Do NOT use edition 2024 (needs rustc ≥ 1.85; this environment is 1.79).
- **Package manager is `pnpm@9.15.6`; Node 22.** Use `pnpm`, never `npm`/`yarn`.
- **Engine constants (verbatim from `src/lib/character/character.ts`):** `MAX_STAT = 10`, `MITIGATION_PER_POINT = 0.2`, `LIGHT_VULNERABILITY = 1.5`.
- **Boundary marshalling:** primitives (`u32`, `f64`, `bool`) cross `wasm-bindgen` directly; structs cross via `serde-wasm-bindgen`.

## File Structure

**Created:**
- `Cargo.toml` — workspace root (members: the two crates).
- `crates/wickedways-core/Cargo.toml`, `crates/wickedways-core/src/lib.rs` — core crate root + feature wiring.
- `crates/wickedways-core/src/dice.rs` — `roll`.
- `crates/wickedways-core/src/stats.rs` — `StatType` + `mitigator()`.
- `crates/wickedways-core/src/damage.rs` — `DamageInput` + `compute_mitigated_damage`.
- `crates/wickedways-wasm/Cargo.toml`, `crates/wickedways-wasm/src/lib.rs` — WASM bindings.
- `generated/bindings/*.ts` — ts-rs output (committed artifact).
- `conformance/seeded-rng.ts` — deterministic `mulberry32` PRNG for input generation.
- `conformance/vitest.config.ts` — vitest config scoped to the conformance suite.
- `conformance/stat-mitigator.test.ts`, `conformance/roll.test.ts`, `conformance/mitigated-damage.test.ts` — the three differential suites.
- `src/lib/character/damage.ts` — pure TS mitigation formula extracted from `takeDamage` (the oracle seam).
- `vitest.config.ts` — root config that **excludes** `conformance/**` from the default `pnpm test`.

**Modified:**
- `package.json` — add `wasm:build`, `bindings:gen`, `bindings:check`, `test:conformance`, `checks:phase0` scripts.
- `src/lib/character/character.ts` — `takeDamage` calls `computeMitigatedDamage` (behavior unchanged).
- `.gitignore` — ignore `target/` and `crates/wickedways-wasm/pkg/`.
- `README.md` — short "Rust core (Phase 0)" note.

---

### Task 1: Toolchain + Cargo workspace + WASM build proof

Establish `rustup`, the `wasm32` target, `wasm-pack`, the two-crate Cargo workspace, and prove a trivial function compiles to WASM and loads in Node.

**Files:**
- Create: `Cargo.toml`, `crates/wickedways-core/Cargo.toml`, `crates/wickedways-core/src/lib.rs`, `crates/wickedways-wasm/Cargo.toml`, `crates/wickedways-wasm/src/lib.rs`
- Modify: `.gitignore`, `package.json`

**Interfaces:**
- Produces: workspace builds; `wasm-pack build crates/wickedways-wasm --target nodejs --out-dir pkg` emits `crates/wickedways-wasm/pkg/wickedways_wasm.js` exporting `ping(): number`.

- [ ] **Step 1: Install the Rust/WASM toolchain**

Homebrew Rust cannot add cross-compile targets; install `rustup` and pin a toolchain, then add the WASM target and `wasm-pack`.

```bash
# If `rustup` is absent (Homebrew rustc has no target management):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

- [ ] **Step 2: Verify the toolchain**

Run:
```bash
rustup target list --installed | grep wasm32-unknown-unknown
wasm-pack --version
```
Expected: `wasm32-unknown-unknown` is listed; `wasm-pack 0.x.y` prints.

- [ ] **Step 3: Create the workspace root `Cargo.toml`**

```toml
[workspace]
resolver = "2"
members = ["crates/wickedways-core", "crates/wickedways-wasm"]
```

- [ ] **Step 4: Create `crates/wickedways-core/Cargo.toml`**

```toml
[package]
name = "wickedways-core"
version = "0.0.1"
edition = "2021"

[features]
default = ["std"]
std = ["serde/std"]
ts = ["dep:ts-rs", "std"]

[dependencies]
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
ts-rs = { version = "10", optional = true }

[dev-dependencies]
proptest = "1"
```

- [ ] **Step 5: Create `crates/wickedways-core/src/lib.rs`**

```rust
//! Pure, host-agnostic engine core. `no_std`-friendly (invariant 5).
#![cfg_attr(not(feature = "std"), no_std)]

pub mod dice;
pub mod stats;
pub mod damage;

pub use dice::roll;
pub use damage::{compute_mitigated_damage, DamageInput, LIGHT_VULNERABILITY, MAX_STAT, MITIGATION_PER_POINT};
pub use stats::StatType;
```

Note: `dice`, `stats`, `damage` are created in later tasks. For Task 1, create them as empty placeholders so the crate compiles:

```bash
mkdir -p crates/wickedways-core/src
printf '' > crates/wickedways-core/src/dice.rs
printf '' > crates/wickedways-core/src/stats.rs
printf '' > crates/wickedways-core/src/damage.rs
```

Then, for Task 1 only, comment out the `pub mod`/`pub use` lines that reference not-yet-written items so the crate builds. Re-enable each as its module is implemented:

```rust
#![cfg_attr(not(feature = "std"), no_std)]
// modules are wired up as they are implemented in Tasks 2–5
```

- [ ] **Step 6: Create `crates/wickedways-wasm/Cargo.toml`**

```toml
[package]
name = "wickedways-wasm"
version = "0.0.1"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wickedways-core = { path = "../wickedways-core", features = ["std", "ts"] }
wasm-bindgen = "0.2"
serde-wasm-bindgen = "0.6"
```

- [ ] **Step 7: Create `crates/wickedways-wasm/src/lib.rs` with a trivial export**

```rust
use wasm_bindgen::prelude::*;

/// Toolchain smoke test: proves Rust→WASM→Node loading works end-to-end.
#[wasm_bindgen]
pub fn ping() -> i32 {
    42
}
```

- [ ] **Step 8: Ignore build artifacts**

Append to `.gitignore`:
```
# Rust / WASM build artifacts
/target
/crates/**/target
/crates/wickedways-wasm/pkg
```

- [ ] **Step 9: Add the `wasm:build` script to `package.json`**

Add to the `"scripts"` block:
```json
"wasm:build": "wasm-pack build crates/wickedways-wasm --target nodejs --out-dir pkg"
```

- [ ] **Step 10: Build and verify native + WASM**

Run:
```bash
cargo build --workspace
cargo build -p wickedways-core --no-default-features   # proves no_std compiles (invariant 5)
pnpm run wasm:build
node -e "console.log(require('./crates/wickedways-wasm/pkg/wickedways_wasm.js').ping())"
```
Expected: native build succeeds; `no_std` build succeeds; `wasm-pack` writes `pkg/`; the `node` line prints `42`.

- [ ] **Step 11: Commit**

```bash
git add Cargo.toml crates/ .gitignore package.json
git commit -m "build: rust+wasm toolchain and cargo workspace (phase 0 task 1)"
```

---

### Task 2: `StatType` enum, ts-rs pipeline, drift check, mitigator differential test

Port the `StatType` enum and the `MitigatorStatType` rock-paper-scissors cycle to Rust, generate the TS binding via ts-rs, add a drift check, and prove the Rust mitigator mapping equals the TS one across the WASM boundary.

**Files:**
- Create: `crates/wickedways-core/src/stats.rs`, `generated/bindings/StatType.ts` (generated), `conformance/stat-mitigator.test.ts`, `conformance/vitest.config.ts`
- Modify: `crates/wickedways-core/src/lib.rs`, `crates/wickedways-wasm/src/lib.rs`, `package.json`

**Interfaces:**
- Consumes: TS `StatType`, `MitigatorStatType` from `src/lib/character/stats.ts`.
- Produces: Rust `StatType` (serde lowercase: `"energy"|"sanity"|"health"`), `StatType::mitigator(self) -> StatType`; WASM `mitigator(stat: string) -> string`.

- [ ] **Step 1: Write the Rust `stats.rs` with the enum + mitigator cycle**

```rust
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// The three core character stats. Serde values match the TS `StatType`
/// string union exactly (`"energy" | "sanity" | "health"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum StatType {
    Energy,
    Sanity,
    Health,
}

impl StatType {
    /// The stat that mitigates incoming damage against this one, forming the
    /// cycle energy←health←sanity←energy (mirror of TS `MitigatorStatType`).
    pub const fn mitigator(self) -> StatType {
        match self {
            StatType::Energy => StatType::Health,
            StatType::Health => StatType::Sanity,
            StatType::Sanity => StatType::Energy,
        }
    }
}
```

- [ ] **Step 2: Wire the module + add the ts-rs export test**

In `crates/wickedways-core/src/lib.rs`, ensure `pub mod stats;` and `pub use stats::StatType;` are active. Append an export test to `stats.rs`:

```rust
#[cfg(all(test, feature = "ts"))]
mod ts_export {
    use super::StatType;
    use ts_rs::TS;

    #[test]
    fn export_typescript_bindings() {
        StatType::export_all().expect("export StatType bindings");
    }
}
```

- [ ] **Step 3: Add `bindings:gen` / `bindings:check` scripts**

Add to `package.json` `"scripts"`:
```json
"bindings:gen": "cd crates/wickedways-core && TS_RS_EXPORT_DIR=../../generated/bindings cargo test --features ts export_typescript_bindings",
"bindings:check": "pnpm run bindings:gen && git diff --exit-code generated/bindings"
```

- [ ] **Step 4: Generate the binding and verify it lands**

Run:
```bash
pnpm run bindings:gen
cat generated/bindings/StatType.ts
```
Expected: `generated/bindings/StatType.ts` exists and reads approximately:
```ts
export type StatType = "energy" | "sanity" | "health";
```

- [ ] **Step 5: Export `mitigator` across the WASM boundary**

Append to `crates/wickedways-wasm/src/lib.rs`:
```rust
use wickedways_core::StatType;

/// Returns the mitigating stat for `stat`, as serde strings, for the
/// conformance harness to diff against the TS `MitigatorStatType`.
#[wasm_bindgen]
pub fn mitigator(stat: &str) -> Result<String, JsValue> {
    let parsed: StatType = serde_json::from_value(serde_json::Value::String(stat.to_string()))
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let out = serde_json::to_value(parsed.mitigator())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(out.as_str().unwrap().to_string())
}
```

Add `serde_json = "1"` to `crates/wickedways-wasm/Cargo.toml` `[dependencies]`.

- [ ] **Step 6: Create `conformance/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["conformance/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 7: Write the failing mitigator differential test**

Create `conformance/stat-mitigator.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MitigatorStatType, StatType } from "../src/lib/character/stats";
import { mitigator as mitigatorWasm } from "../crates/wickedways-wasm/pkg/wickedways_wasm.js";

describe("StatType.mitigator parity (Rust vs TS)", () => {
  it("matches MitigatorStatType for every stat", () => {
    for (const stat of Object.values(StatType)) {
      expect(mitigatorWasm(stat)).toBe(MitigatorStatType[stat]);
    }
  });
});
```

- [ ] **Step 8: Add the `test:conformance` script and run to verify it fails first (no WASM yet for `mitigator`)**

Add to `package.json` `"scripts"`:
```json
"test:conformance": "pnpm run wasm:build && vitest run --config conformance/vitest.config.ts"
```
Run:
```bash
vitest run --config conformance/vitest.config.ts conformance/stat-mitigator.test.ts
```
Expected: FAIL — `mitigator` is not yet in the built `pkg/` (import error or undefined).

- [ ] **Step 9: Build WASM and run the test to verify it passes**

Run:
```bash
pnpm run test:conformance
```
Expected: PASS — `mitigator("energy")==="health"`, `"health"→"sanity"`, `"sanity"→"energy"`.

- [ ] **Step 10: Commit**

```bash
git add crates/ generated/bindings/StatType.ts conformance/ package.json
git commit -m "feat(core): StatType enum + mitigator cycle, ts-rs pipeline, drift check (phase 0 task 2)"
```

---

### Task 3: Port `roll` + seeded-PRNG harness + differential test

Port the dice roll and prove it is identical to the TS `roll` across a deterministic sequence of unit values.

**Files:**
- Create: `crates/wickedways-core/src/dice.rs`, `conformance/seeded-rng.ts`, `conformance/roll.test.ts`
- Modify: `crates/wickedways-core/src/lib.rs`, `crates/wickedways-wasm/src/lib.rs`

**Interfaces:**
- Consumes: TS `roll(sides, rng)` from `src/lib/dice.ts`.
- Produces: Rust `roll(sides: u32, unit: f64) -> u32`; WASM `roll(sides: number, unit: number): number`; `mulberry32(seed: number): () => number`.

- [ ] **Step 1: Write the Rust `dice.rs`**

```rust
/// Rolls a die with `sides` faces from a pre-drawn uniform `unit` in `[0, 1)`.
/// Pure mirror of the TS `roll(sides, rng)`: `floor(unit * sides) + 1`.
pub fn roll(sides: u32, unit: f64) -> u32 {
    (unit * sides as f64).floor() as u32 + 1
}

#[cfg(test)]
mod tests {
    use super::roll;

    #[test]
    fn bottom_of_range_is_one() {
        assert_eq!(roll(6, 0.0), 1);
    }

    #[test]
    fn top_of_range_is_sides() {
        assert_eq!(roll(6, 0.999), 6);
        assert_eq!(roll(100, 0.999), 100);
    }
}
```

Activate `pub mod dice;` and `pub use dice::roll;` in `lib.rs`.

- [ ] **Step 2: Run the Rust unit tests**

Run: `cargo test -p wickedways-core dice`
Expected: PASS (both tests).

- [ ] **Step 3: Export `roll` from WASM**

Append to `crates/wickedways-wasm/src/lib.rs`:
```rust
/// Pure dice roll from a pre-drawn uniform `unit` in `[0, 1)`.
#[wasm_bindgen]
pub fn roll(sides: u32, unit: f64) -> u32 {
    wickedways_core::roll(sides, unit)
}
```

- [ ] **Step 4: Create the seeded PRNG helper**

Create `conformance/seeded-rng.ts`:
```ts
/** Deterministic mulberry32 PRNG → floats in [0, 1). Used to generate
 *  identical input sequences for both engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 5: Write the failing roll differential test**

Create `conformance/roll.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { roll as rollTs } from "../src/lib/dice";
import { roll as rollWasm } from "../crates/wickedways-wasm/pkg/wickedways_wasm.js";
import { mulberry32 } from "./seeded-rng";

describe("roll parity (Rust vs TS)", () => {
  it("is identical across 50k seeded samples and many die sizes", () => {
    const rng = mulberry32(0x5eed);
    const sizes = [2, 4, 6, 8, 10, 12, 20, 100];
    for (let i = 0; i < 50_000; i++) {
      const unit = rng();
      const sides = sizes[i % sizes.length];
      const ts = rollTs(sides, () => unit);
      const rs = rollWasm(sides, unit);
      if (ts !== rs) {
        throw new Error(`divergence at i=${i}: sides=${sides} unit=${unit} ts=${ts} rs=${rs}`);
      }
      expect(rs).toBe(ts);
    }
  });
});
```

- [ ] **Step 6: Run to verify it fails first (roll not yet built into pkg)**

Run: `vitest run --config conformance/vitest.config.ts conformance/roll.test.ts`
Expected: FAIL — `rollWasm` undefined (pkg not rebuilt).

- [ ] **Step 7: Rebuild WASM and run to verify it passes**

Run: `pnpm run test:conformance`
Expected: PASS — all conformance suites green; `roll` identical across 50k samples.

- [ ] **Step 8: Commit**

```bash
git add crates/ conformance/
git commit -m "feat(core): port roll + seeded differential harness (phase 0 task 3)"
```

---

### Task 4: Extract the pure TS mitigation formula (oracle seam)

Refactor the inline damage math out of `Character.takeDamage` into a pure, independently testable function, with behavior unchanged. This becomes the oracle the Rust port is diffed against.

**Files:**
- Create: `src/lib/character/damage.ts`
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/damage.test.ts`

**Interfaces:**
- Produces: `computeMitigatedDamage(input: DamageInput): number`; `DamageInput { attackStrength, armorSum, mitigator, lightAverse, roomLit }`; re-exported `MAX_STAT`, `MITIGATION_PER_POINT`, `LIGHT_VULNERABILITY`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/character/damage.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeMitigatedDamage } from "./damage";

describe("computeMitigatedDamage", () => {
  it("armor soaks raw strength before mitigation", () => {
    // strength 10, armor 4 → mitigatedStrength 6; mitigator 0 → multiplier 10*0.2=2; no light
    expect(
      computeMitigatedDamage({ attackStrength: 10, armorSum: 4, mitigator: 0, lightAverse: false, roomLit: false }),
    ).toBe(12);
  });

  it("a full mitigator (>= MAX_STAT) absorbs the hit entirely", () => {
    expect(
      computeMitigatedDamage({ attackStrength: 10, armorSum: 0, mitigator: 10, lightAverse: false, roomLit: false }),
    ).toBe(0);
  });

  it("light-averse in a lit room multiplies by LIGHT_VULNERABILITY", () => {
    // mitigatedStrength 5, mitigator 5 → multiplier 5*0.2=1; light 1.5 → 7.5
    expect(
      computeMitigatedDamage({ attackStrength: 5, armorSum: 0, mitigator: 5, lightAverse: true, roomLit: true }),
    ).toBe(7.5);
  });

  it("never returns negative when armor exceeds strength", () => {
    expect(
      computeMitigatedDamage({ attackStrength: 3, armorSum: 9, mitigator: 0, lightAverse: false, roomLit: false }),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/character/damage.test.ts`
Expected: FAIL — `./damage` not found.

- [ ] **Step 3: Create `src/lib/character/damage.ts`**

```ts
/** Damage mitigation: a mitigating stat of MAX_STAT fully absorbs the hit, while
 *  a mitigator of 0 doubles it. Each point of the mitigating stat removes
 *  MITIGATION_PER_POINT of the incoming damage multiplier. */
export const MAX_STAT = 10;
export const MITIGATION_PER_POINT = 0.2;
/** Damage multiplier applied to a light-averse creature while its room is lit. */
export const LIGHT_VULNERABILITY = 1.5;

/** Pure inputs to the mitigation formula (pre-mechanics-transform). */
export interface DamageInput {
  attackStrength: number;
  armorSum: number;
  mitigator: number;
  lightAverse: boolean;
  roomLit: boolean;
}

/** The pure damage-mitigation formula from `Character.takeDamage`, extracted so
 *  it is independently testable and can serve as the conformance oracle. */
export function computeMitigatedDamage(input: DamageInput): number {
  const mitigatedStrength = Math.max(0, input.attackStrength - input.armorSum);
  const damageMultiplier = Math.max(0, MAX_STAT - input.mitigator) * MITIGATION_PER_POINT;
  const lightMultiplier = input.lightAverse && input.roomLit ? LIGHT_VULNERABILITY : 1;
  return mitigatedStrength * damageMultiplier * lightMultiplier;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/character/damage.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Refactor `takeDamage` to use the extracted function**

In `src/lib/character/character.ts`: (a) remove the local `const MAX_STAT = 10;` and `const MITIGATION_PER_POINT = 0.2;` declarations (~lines 34–35); (b) remove the local `export const LIGHT_VULNERABILITY = 1.5;` (~line 38); (c) add an import near the top:
```ts
import { computeMitigatedDamage, LIGHT_VULNERABILITY } from "./damage";
```
and re-export it to preserve the existing public surface:
```ts
export { LIGHT_VULNERABILITY } from "./damage";
```
Then replace the inline computation (the `mitigatedStrength`/`damageMultiplier`/`lightMultiplier`/`finalAttackStrength` block, ~lines 948–954) with:
```ts
const armorSum = armor.reduce((sum, piece) => sum + piece.modifier, 0);
const finalAttackStrength = computeMitigatedDamage({
  attackStrength,
  armorSum,
  mitigator: this.effectiveStat(MitigatorStatType[attackStat]),
  lightAverse: this.lightAverse,
  roomLit: this.#currentRoom?.isLit ?? false,
});
```
(Keep the existing `armor` filter above it and the `dealt`/`TRANSFORM_DAMAGE`/durability/`#reconcile`/`recordAction` lines below it untouched.)

- [ ] **Step 6: Verify the full engine suite is unchanged**

Run: `pnpm run checks`
Expected: lint + typecheck + **all existing tests pass** — `takeDamage` behavior is identical; this is a pure extraction.

- [ ] **Step 7: Commit**

```bash
git add src/lib/character/damage.ts src/lib/character/damage.test.ts src/lib/character/character.ts
git commit -m "refactor(character): extract pure computeMitigatedDamage (phase 0 task 4)"
```

---

### Task 5: Port the mitigation formula to Rust over the serde boundary + generative differential fuzz

Port `compute_mitigated_damage` to Rust with a `DamageInput` struct crossing via `serde-wasm-bindgen`, add a Rust property test for the non-negativity invariant, generate the `DamageInput` TS binding, and prove float-exact parity over tens of thousands of seeded random inputs.

**Files:**
- Create: `crates/wickedways-core/src/damage.rs`, `generated/bindings/DamageInput.ts` (generated), `conformance/mitigated-damage.test.ts`
- Modify: `crates/wickedways-core/src/lib.rs`, `crates/wickedways-wasm/src/lib.rs`, `crates/wickedways-core/src/stats.rs` (export test)

**Interfaces:**
- Consumes: TS `computeMitigatedDamage`, `DamageInput` from `src/lib/character/damage.ts`; `mulberry32` from `conformance/seeded-rng.ts`.
- Produces: Rust `compute_mitigated_damage(DamageInput) -> f64`; `DamageInput { attack_strength, armor_sum, mitigator, light_averse, room_lit }` (camelCase over the wire); WASM `mitigated_damage(input: DamageInput): number`.

- [ ] **Step 1: Write the Rust `damage.rs`**

```rust
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

pub const MAX_STAT: f64 = 10.0;
pub const MITIGATION_PER_POINT: f64 = 0.2;
pub const LIGHT_VULNERABILITY: f64 = 1.5;

/// Pure inputs to the mitigation formula. Field names cross the boundary in
/// camelCase to match the TS `DamageInput` (invariant 1).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export, rename_all = "camelCase"))]
#[serde(rename_all = "camelCase")]
pub struct DamageInput {
    pub attack_strength: f64,
    pub armor_sum: f64,
    pub mitigator: f64,
    pub light_averse: bool,
    pub room_lit: bool,
}

/// Mirror of TS `computeMitigatedDamage`. Identical IEEE-754 operation order so
/// results are byte-identical (invariant 3).
pub fn compute_mitigated_damage(input: DamageInput) -> f64 {
    let mitigated_strength = (input.attack_strength - input.armor_sum).max(0.0);
    let damage_multiplier = (MAX_STAT - input.mitigator).max(0.0) * MITIGATION_PER_POINT;
    let light_multiplier = if input.light_averse && input.room_lit { LIGHT_VULNERABILITY } else { 1.0 };
    mitigated_strength * damage_multiplier * light_multiplier
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn full_mitigator_absorbs_hit() {
        let i = DamageInput { attack_strength: 10.0, armor_sum: 0.0, mitigator: 10.0, light_averse: false, room_lit: false };
        assert_eq!(compute_mitigated_damage(i), 0.0);
    }

    proptest! {
        #[test]
        fn never_negative(
            attack in 0.0f64..1000.0, armor in 0.0f64..1000.0,
            mit in 0.0f64..20.0, la in any::<bool>(), lit in any::<bool>(),
        ) {
            let d = compute_mitigated_damage(DamageInput {
                attack_strength: attack, armor_sum: armor, mitigator: mit, light_averse: la, room_lit: lit,
            });
            prop_assert!(d >= 0.0);
        }
    }
}
```

Activate `pub mod damage;` and the `pub use damage::{...}` line in `lib.rs`.

- [ ] **Step 2: Run the Rust tests**

Run: `cargo test -p wickedways-core damage`
Expected: PASS (unit test + proptest).

- [ ] **Step 3: Add `DamageInput` to the ts-rs export test**

In `crates/wickedways-core/src/stats.rs`'s `ts_export` module (or move the export test to `lib.rs`), export `DamageInput` too:
```rust
#[cfg(all(test, feature = "ts"))]
mod ts_export {
    use crate::{damage::DamageInput, stats::StatType};
    use ts_rs::TS;

    #[test]
    fn export_typescript_bindings() {
        StatType::export_all().expect("export StatType");
        DamageInput::export_all().expect("export DamageInput");
    }
}
```
(Remove the now-duplicated export test from `stats.rs` if you keep this one in `lib.rs`; there must be exactly one test named `export_typescript_bindings`.)

- [ ] **Step 4: Regenerate bindings and verify `DamageInput.ts`**

Run:
```bash
pnpm run bindings:gen
cat generated/bindings/DamageInput.ts
```
Expected: a `DamageInput` interface with `attackStrength`, `armorSum`, `mitigator`, `lightAverse`, `roomLit`.

- [ ] **Step 5: Export `mitigated_damage` from WASM via serde-wasm-bindgen**

Append to `crates/wickedways-wasm/src/lib.rs`:
```rust
use wickedways_core::{compute_mitigated_damage, DamageInput};

/// Mitigation formula over the serde boundary. Proves struct marshalling
/// (serde-wasm-bindgen) end-to-end.
#[wasm_bindgen]
pub fn mitigated_damage(input: JsValue) -> Result<f64, JsValue> {
    let parsed: DamageInput = serde_wasm_bindgen::from_value(input)?;
    Ok(compute_mitigated_damage(parsed))
}
```

- [ ] **Step 6: Write the failing generative differential test**

Create `conformance/mitigated-damage.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeMitigatedDamage, type DamageInput } from "../src/lib/character/damage";
import { mitigated_damage as mitigatedWasm } from "../crates/wickedways-wasm/pkg/wickedways_wasm.js";
import { mulberry32 } from "./seeded-rng";

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
```

- [ ] **Step 7: Run to verify it fails first (mitigated_damage not yet built)**

Run: `vitest run --config conformance/vitest.config.ts conformance/mitigated-damage.test.ts`
Expected: FAIL — `mitigatedWasm` undefined (pkg not rebuilt).

- [ ] **Step 8: Rebuild WASM and run the full conformance suite**

Run: `pnpm run test:conformance`
Expected: PASS — float-exact across 100k inputs. If this diverges, investigate operation order / float handling before proceeding (this is the determinism gate, invariant 3).

- [ ] **Step 9: Commit**

```bash
git add crates/ generated/bindings/DamageInput.ts conformance/mitigated-damage.test.ts
git commit -m "feat(core): port mitigation formula over serde boundary + generative diff (phase 0 task 5)"
```

---

### Task 6: Phase 0 gate — wire scripts, drift check, and docs

Bundle the Phase 0 checks into a single command, enforce binding-drift in that gate, and document the Rust core entry point so downstream phases have a known starting command.

**Files:**
- Modify: `package.json`, `README.md`

**Interfaces:**
- Produces: `pnpm run checks:phase0` runs the full Phase 0 gate (cargo tests, binding drift, WASM build, conformance diffs).

- [ ] **Step 1: Add the `checks:phase0` aggregate script**

Add to `package.json` `"scripts"`:
```json
"checks:phase0": "cargo test --workspace && cargo test -p wickedways-core --features ts && pnpm run bindings:check && pnpm run test:conformance"
```

- [ ] **Step 2: Run the full gate**

Run: `pnpm run checks:phase0`
Expected: cargo tests pass; `bindings:check` reports no drift (clean `git diff`); WASM builds; all three conformance suites pass.

- [ ] **Step 3: Prove the drift check actually catches drift**

Temporarily edit `generated/bindings/StatType.ts` (e.g. add a stray comment), then run:
```bash
pnpm run bindings:check
```
Expected: FAIL with a non-empty `git diff` (proves invariant 7 is enforced). Then restore:
```bash
git checkout generated/bindings/StatType.ts
```

- [ ] **Step 4: Document the Rust core in `README.md`**

Add a short section after the existing architecture overview:
```markdown
### Rust core (Phase 0, in progress)

The engine is being re-authored as a Rust core (`crates/wickedways-core`) compiled to
WASM (`crates/wickedways-wasm`) per `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md`.
Phase 0 ports pure-leaf math (`roll`, the stat-mitigator cycle, the damage-mitigation
formula) and proves the toolchain. Boundary types are defined in Rust and generated to
`generated/bindings/` via ts-rs (do not hand-edit). Run the Phase 0 gate with:

    pnpm run checks:phase0
```

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "build: phase 0 conformance gate + docs (phase 0 task 6)"
```

---

## Self-Review

**Spec coverage (Phase 0 scope only):**
- Stand up `wickedways-core` + `wickedways-wasm` crates → Task 1. ✓
- `ts-rs` generation pipeline + drift check (invariants 1, 7) → Tasks 2, 5, 6. ✓
- `serde-wasm-bindgen` boundary (struct crossing) → Task 5. ✓
- Differential harness (TS oracle vs Rust, seeded, first-divergence report) → Tasks 3, 5. ✓
- Port pure leaves: `dice`, mitigation math, `stats` → Tasks 3, 5, 2. ✓
- `no_std`-friendly core proven (invariant 5) → Task 1 Step 10 (`--no-default-features` build). ✓
- Determinism asserted exactly (invariant 3) → `Object.is` diffs in Tasks 3, 5. ✓
- Later phases (stateful core, cutover, delete oracle) → **out of scope**, each gets its own plan.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"; every code step shows full code. ✓

**Type consistency:** `DamageInput` fields are camelCase on both sides (TS `attackStrength…`; Rust `#[serde(rename_all="camelCase")]`). `StatType` serde values lowercase match the TS union. WASM exports (`ping`, `mitigator`, `roll`, `mitigated_damage`) referenced in conformance tests match their `#[wasm_bindgen]` definitions. The single ts-rs export test is named `export_typescript_bindings` (Task 5 Step 3 consolidates it). ✓
