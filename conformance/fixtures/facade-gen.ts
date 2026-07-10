/**
 * Shared facade-golden driver: runs a FacadeOp stream against the OracleSession
 * and captures per-step { op, result, snapshot, view }. The projected view drops
 * only room.image (never emitted by the Rust core — host overlay concern);
 * fixture campaigns carry no presentation assets, so everything else diffs 1:1.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { structuralClone } from "./gen-helpers.ts";
import type { Intent, OracleSession } from "./oracle-session.ts";
import type { CampaignTemplateDescription } from "wickedways/lib/authoring/description";

/** `CampaignTemplateDescription.opts.rng` is a function; strip it before serializing. */
export function stripRng(d: CampaignTemplateDescription): Omit<CampaignTemplateDescription, "opts"> & {
  opts: Omit<CampaignTemplateDescription["opts"], "rng">;
} {
  const { rng: _rng, ...opts } = d.opts;
  return { ...d, opts };
}

export type FacadeOp =
  | { kind: "submit"; intent: Intent }
  | { kind: "read"; itemId: string }
  | { kind: "examine"; targetId: string }
  | { kind: "undo" };

export function facadeViewProjected(oracle: OracleSession) {
  const full = oracle.view();
  const { image: _img, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  return { ...full, room: roomRest };
}

export function runFacadeGolden(oracle: OracleSession, ops: FacadeOp[]): FacadeStep[] {
  return ops.map((op) => {
    let result: unknown;
    if (op.kind === "submit") result = oracle.execute(op.intent);
    else if (op.kind === "read") result = oracle.read(op.itemId);
    else if (op.kind === "examine") result = oracle.examine(op.targetId);
    else result = { ok: oracle.undo() };
    return {
      op,
      result: structuralClone(result),
      snapshot: structuralClone(serializeCampaign(oracle.campaign)),
      view: structuralClone(facadeViewProjected(oracle)),
    };
  });
}

export interface FacadeStep {
  op: FacadeOp;
  result: unknown;
  snapshot: unknown;
  view: unknown;
}

/** Writes the three fixture files and RETURNS the steps so generators can
 *  assert their coverage bars (mirrors the victory-won generator style). */
export function writeFacadeFixture(
  here: string,
  name: string,
  seed: number,
  oracle: OracleSession,
  catalog: unknown,
  ops: FacadeOp[],
  description: CampaignTemplateDescription,
): FacadeStep[] {
  const startupCues = structuralClone(oracle.startupCues);
  const genesis = structuralClone(oracle.genesis);
  const steps = runFacadeGolden(oracle, ops);
  writeFileSync(join(here, `${name}.genesis.json`), JSON.stringify(genesis, null, 2) + "\n");
  writeFileSync(join(here, `${name}.catalog.json`), JSON.stringify(catalog, null, 2) + "\n");
  // The description is the assembler's INPUT artifact; genesis is its output. Emitting
  // it here lets the Rust assembler be gated against the genesis golden beside it.
  // Note `opts.rng` is a closure and is dropped — the seed reaches the engine via
  // `Authority::new` instead.
  writeFileSync(
    join(here, `${name}.description.json`),
    JSON.stringify(stripRng(description), null, 2) + "\n",
  );
  writeFileSync(
    join(here, `${name}.golden.json`),
    JSON.stringify({ seed, startupCues, ops, steps }, null, 2) + "\n",
  );
  return steps;
}
