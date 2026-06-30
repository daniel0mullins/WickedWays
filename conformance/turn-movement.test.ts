import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (start_snapshot_json: string, commands_json: string) => string;
};

const start = readFileSync(
  join(here, "fixtures/turn-movement.start.snapshot.json"),
  "utf8",
);
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/turn-movement.golden.json"), "utf8"),
) as {
  commands: unknown[];
  steps: Array<{
    command: unknown;
    cues: unknown;
    snapshot: unknown;
    viewThin: unknown;
  }>;
};

describe("turn-movement differential conformance", () => {
  it("Rust replay matches the TS oracle per step (cues + snapshot + thin view)", () => {
    const out = JSON.parse(
      wasm.replay_commands(start, JSON.stringify(golden.commands)),
    ) as Array<{
      command: unknown;
      cues: unknown;
      snapshot: unknown;
      viewThin: unknown;
    }>;
    expect(out.length).toBe(golden.steps.length);
    out.forEach((step, i) => {
      const want = golden.steps[i]!;
      expect(canonicalize(step.cues), `step ${i} cues`).toEqual(
        canonicalize(want.cues),
      );
      expect(canonicalize(step.snapshot), `step ${i} snapshot`).toEqual(
        canonicalize(want.snapshot),
      );
      expect(canonicalize(step.viewThin), `step ${i} viewThin`).toEqual(
        canonicalize(want.viewThin),
      );
    });
  });
});
