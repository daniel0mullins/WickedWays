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

export type FacadeOp =
  | { kind: "submit"; intent: Intent }
  | { kind: "read"; itemId: string }
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
): FacadeStep[] {
  const startupCues = structuralClone(oracle.startupCues);
  const genesis = structuralClone(oracle.genesis);
  const steps = runFacadeGolden(oracle, ops);
  writeFileSync(join(here, `${name}.genesis.json`), JSON.stringify(genesis, null, 2) + "\n");
  writeFileSync(join(here, `${name}.catalog.json`), JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(
    join(here, `${name}.golden.json`),
    JSON.stringify({ seed, startupCues, ops, steps }, null, 2) + "\n",
  );
  return steps;
}
