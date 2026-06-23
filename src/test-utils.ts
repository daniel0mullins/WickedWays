import { vi } from "vitest";

import type { ICampaign } from "./lib/campaign";
import type { ICharacter } from "./lib/character/character";
import type { Archetype, ArchetypeId } from "./lib/archetype";
import type { IPlayerCharacter } from "./lib/character/player-character";
import { StatType, type Stats } from "./lib/character/stats";
import type { RoomExits } from "./lib/room";
import { EMIT_CUE, NOTE_ENCOUNTERS } from "./lib/presentation";
import { RECORD_ENCOUNTER } from "./lib/codex";
import { DISPATCH_TURN, DISPATCH_ACTION, TRANSFORM_DAMAGE, INVOKE_MECHANIC_ACTION } from "./lib/mechanics/symbols";

// The Room constructor types `exits` as a full RoomExits map, but the body only
// iterates whatever keys are present, so tests cast partial (or empty) maps into
// it. Re-exported under the historic name the test suite uses.
export type ExitsArg = RoomExits;

// A full stat block with every stat at 10, overridable per stat.
export function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
    ...overrides,
  };
}

// Character only stores the campaign and exposes it via a getter, so a bare
// stub is enough for tests that never drive campaign behaviour. It carries a
// minimal archetype catalog so `selectArchetype` (the only seam for non-default
// starting stats) works against the stub — see `setStartingStats`.
export function makeCampaign(): ICampaign {
  const archetypes = new Map<ArchetypeId, Archetype>();
  return {
    maybeSpawn: () => [],
    addFormation: () => {},
    started: false,
    archetypes,
    registerArchetype: (a: Archetype) => archetypes.set(a.id, a),
    [EMIT_CUE]: () => {},
    [NOTE_ENCOUNTERS]: () => {},
    [RECORD_ENCOUNTER]: () => {},
    [DISPATCH_TURN]: () => {},
    [DISPATCH_ACTION]: () => {},
    [TRANSFORM_DAMAGE]: (dv: { amount: number }) => dv.amount,
    [INVOKE_MECHANIC_ACTION]: () => {},
  } as unknown as ICampaign;
}

// Player characters take no stats argument — an archetype is the only seam for
// non-default starting stats. This registers a one-off archetype whose
// baseStats override the baseline (10) for the requested stats and selects
// it, giving a test a PC with specific starting stats via the public API.
export function setStartingStats(
  campaign: ICampaign,
  pc: IPlayerCharacter,
  target: Partial<Stats>,
): void {
  const baseStats: Partial<Stats> = {};
  for (const stat of [StatType.Health, StatType.Sanity, StatType.Energy] as const) {
    const want = target[stat];
    if (want !== undefined) baseStats[stat] = want;
  }
  const id = `stats:${pc.id}` as ArchetypeId;
  campaign.registerArchetype({ id, name: id, baseStats });
  pc.selectArchetype(id);
}

// A defender that only needs to record the damage calls made against it.
export function makeDefender(): ICharacter {
  return { id: "defender-1", name: "Goblin", takeDamage: vi.fn() } as unknown as ICharacter;
}

// A no-op archetype for tests that must satisfy beginCampaign's requirement
// without exercising any archetype effect.
export const NEUTRAL_ARCHETYPE: Archetype = {
  id: "neutral" as ArchetypeId,
  name: "Neutral",
};

// Registers NEUTRAL_ARCHETYPE on the campaign and assigns it to each PC, so
// beginCampaign's archetype requirement is satisfied.
export function assignNeutralArchetype(
  campaign: ICampaign,
  ...pcs: IPlayerCharacter[]
): void {
  campaign.registerArchetype(NEUTRAL_ARCHETYPE);
  for (const pc of pcs) {
    pc.selectArchetype(NEUTRAL_ARCHETYPE.id);
  }
}

// Deterministic mulberry32 PRNG so buildMap produces a fixed topology.
export function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
