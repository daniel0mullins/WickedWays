/**
 * Authority-driven replay: boots `new Authority(genesis, catalog, seed)`,
 * compares startup cues, then replays the op stream comparing
 * { result, snapshot, view } per step (canonicalized). Undo is mirrored
 * host-side exactly as the cutover GameSession does it: stash snapshot()
 * before a successful advancing submit; undo = restore(stash).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { expect } from "vitest";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const TIME_ADVANCING = new Set(["move", "take", "drop", "use", "attack", "wait", "talk"]);

interface GoldenStep { op: { kind: string; intent?: { kind: string }; itemId?: string }; result: unknown; snapshot: unknown; view: unknown; }
interface Golden { seed: number; startupCues: unknown[]; ops: unknown[]; steps: GoldenStep[]; }

export function replayFacade(name: string): void {
  const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
    Authority: new (genesis: string, catalog: string, seed: number) => {
      takeStartupCues(): string;
      submit(intent: string): string;
      read(itemId: string): string;
      snapshot(): string;
      restore(snapshot: string): void;
      view(): string;
    };
  };
  const genesis = readFileSync(join(here, `fixtures/${name}.genesis.json`), "utf8");
  const catalog = readFileSync(join(here, `fixtures/${name}.catalog.json`), "utf8");
  const golden = JSON.parse(readFileSync(join(here, `fixtures/${name}.golden.json`), "utf8")) as Golden;

  const auth = new wasm.Authority(genesis, catalog, golden.seed);
  expect(canonicalize(JSON.parse(auth.takeStartupCues())), "startup cues").toEqual(
    canonicalize(golden.startupCues),
  );

  let undoStash: string | null = null;
  golden.steps.forEach((want, i) => {
    let got: unknown;
    if (want.op.kind === "submit") {
      const advancing = TIME_ADVANCING.has(want.op.intent!.kind);
      const pre = advancing ? auth.snapshot() : null;
      const result = JSON.parse(auth.submit(JSON.stringify(want.op.intent))) as { error?: string };
      if (advancing && result.error === undefined && pre !== null) undoStash = pre;
      got = result;
    } else if (want.op.kind === "read") {
      got = JSON.parse(auth.read(want.op.itemId!));
    } else {
      const ok = undoStash !== null;
      if (undoStash !== null) { auth.restore(undoStash); undoStash = null; }
      got = { ok };
    }
    expect(canonicalize(got), `step ${i} result`).toEqual(canonicalize(want.result));
    expect(canonicalize(JSON.parse(auth.snapshot())), `step ${i} snapshot`).toEqual(canonicalize(want.snapshot));
    expect(canonicalize(JSON.parse(auth.view())), `step ${i} view`).toEqual(canonicalize(want.view));
  });
}
