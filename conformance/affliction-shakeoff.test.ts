import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (
    start_snapshot_json: string,
    commands_json: string,
    catalog_json: string,
    seed: number,
  ) => string;
};

const start = readFileSync(
  join(here, "fixtures/affliction-shakeoff.start.snapshot.json"),
  "utf8",
);
const catalogJson = readFileSync(
  join(here, "fixtures/affliction-shakeoff.catalog.json"),
  "utf8",
);
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/affliction-shakeoff.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("affliction shake-off differential conformance", () => {
  it("Rust replay matches the TS oracle per step and persists a non-empty shakenOff", () => {
    // Coverage guard: the golden must actually contain a non-empty shakenOff.
    const hasShaken = golden.steps.some((s) => {
      const chars =
        (s.snapshot as { characters?: Array<{ afflictions?: { shakenOff?: unknown[] } }> })
          .characters ?? [];
      return chars.some((ch) => (ch.afflictions?.shakenOff?.length ?? 0) > 0);
    });
    expect(hasShaken, "golden must persist a non-empty shakenOff").toBe(true);

    const out = JSON.parse(
      wasm.replay_commands(
        start,
        JSON.stringify(golden.commands),
        catalogJson,
        golden.seed,
      ),
    ) as Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;

    expect(out.length).toBe(golden.steps.length);
    out.forEach((step, i) => {
      const want = golden.steps[i]!;
      expect(canonicalize(step.cues), `step ${i} cues`).toEqual(canonicalize(want.cues));
      expect(canonicalize(step.snapshot), `step ${i} snapshot`).toEqual(
        canonicalize(want.snapshot),
      );
      expect(canonicalize(step.view), `step ${i} view`).toEqual(canonicalize(want.view));
    });
  });
});
