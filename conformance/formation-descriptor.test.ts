import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (s: string, c: string, cat: string, seed: number) => string;
};

// Both descriptor-formation goldens: the single-rat spawn and the two-rat pair.
// Each proves the Rust `Catalog.formations` descriptor build + `World::maybe_spawn`
// drop-seeding matches the TS `descriptorToFormation` oracle byte-for-byte.
const FIXTURES = ["formation-descriptor-single", "formation-descriptor-pair"] as const;

describe("descriptor-formation spawn differential conformance", () => {
  for (const name of FIXTURES) {
    it(`${name}: Rust replay matches the TS oracle per step (cues + snapshot + view)`, () => {
      const start = readFileSync(join(here, `fixtures/${name}.start.snapshot.json`), "utf8");
      const catalogJson = readFileSync(join(here, `fixtures/${name}.catalog.json`), "utf8");
      const golden = JSON.parse(readFileSync(join(here, `fixtures/${name}.golden.json`), "utf8")) as {
        seed: number;
        commands: unknown[];
        steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
      };

      const out = JSON.parse(
        wasm.replay_commands(start, JSON.stringify(golden.commands), catalogJson, golden.seed),
      ) as Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;

      expect(out.length).toBe(golden.steps.length);
      out.forEach((step, i) => {
        const want = golden.steps[i]!;
        expect(canonicalize(step.cues), `${name} step ${i} cues`).toEqual(canonicalize(want.cues));
        expect(canonicalize(step.snapshot), `${name} step ${i} snapshot`).toEqual(canonicalize(want.snapshot));
        expect(canonicalize(step.view), `${name} step ${i} view`).toEqual(canonicalize(want.view));
      });
    });
  }
});
