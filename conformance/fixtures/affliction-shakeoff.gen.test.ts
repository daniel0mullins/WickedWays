/**
 * Affliction shake-off golden generator — run once to write the committed fixture files.
 *
 * COVERAGE fixture (Phase-1 gap): every other committed affliction golden has
 * `shakenOff: []`. This one drives a single Confused character (energy 0, never
 * recovered) through enough turns that the turn-start shake-off roll is GUARANTEED
 * to land (Confused odds reach 100% by the 8th turn) and — because the episode is
 * never cleared — PERSISTS a non-empty `shakenOff` in the serialized snapshot.
 *
 * Two PCs, both in one lit Hall, no items/loot/encounters (baseEncounterChance 0),
 * so the ONLY rng draws are Ada's Confused clear rolls (one per Ada startTurn after
 * the latch). All draws come from a single shared `mulberry32(SEED)` instance —
 * mirroring the Rust World's single `pub rng: Rng` seeded via `replay_commands`.
 * The start snapshot is serialized BEFORE the first startTurn (nothing draws at boot).
 *
 * Writes: affliction-shakeoff.start.snapshot.json / .catalog.json / .golden.json.
 * Run via: pnpm run fixtures:gen  (excluded from the replay gate; see conformance/vitest.config.ts)
 *
 * Replay contract (Task B2): each `golden.commands` entry deserializes into the
 * Rust Command enum: { "kind": "startTurn" } | { "kind": "nextPlayer" }.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import type { PresentationCue } from "wickedways/lib/presentation";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

type Command = { kind: "startTurn" } | { kind: "nextPlayer" };

// 8 rounds. Each round: Ada.startTurn (1 Confused clear roll after the latch) →
// nextPlayer → Ben.startTurn (Ben has no afflictions → 0 draws) → nextPlayer.
// By Ada's 8th startTurn the Confused clear odds hit 100% (15 + 15*6 → clamp 100),
// so a shake-off is guaranteed to land and persist (energy stays 0 → never cleared).
const COMMANDS: Command[] = [];
for (let r = 0; r < 8; r++) {
  COMMANDS.push({ kind: "startTurn" }); // Ada
  COMMANDS.push({ kind: "nextPlayer" }); // → Ben
  COMMANDS.push({ kind: "startTurn" }); // Ben (0 draws)
  COMMANDS.push({ kind: "nextPlayer" }); // → next round, Ada
}

// Two archetypes: Ada = energy 0 → Confused (the sole clearable); Ben = all healthy.
function buildCampaign(rng: () => number) {
  const registry = defineRegistry({ items: {} });
  const template = authorTemplate("Affliction shake-off (conformance)", registry, {
    rng,
    maxRounds: 40,
    baseEncounterChance: 0,
  })
    .archetype({
      id: "rattled",
      name: "Rattled",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 0, // energy<=0 → Confused
      },
    })
    .archetype({
      id: "steady",
      name: "Steady",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10, // no afflictions
      },
    })
    .room("Hall", { description: "A cold stone hall." })
    .startRoom("Hall");

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("rattled" as never);
  ada.move(hall);

  const ben = new PlayerCharacter({ campaign, name: "Ben", rng });
  ben.id = "player:Ben" as CharacterId;
  ben.joinCampaign();
  ben.selectArchetype("steady" as never);
  ben.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();
  return campaign;
}

type Step = { command: Command; cues: PresentationCue[]; snapshot: unknown; view: unknown };

function driveAndCapture(seed: number): { start: unknown; steps: Step[] } {
  const rng = mulberry32(seed);
  const campaign = buildCampaign(rng);
  const start = serializeCampaign(campaign); // pre-command; no rng drawn yet

  let buf: PresentationCue[] = [];
  campaign.onCue((c: PresentationCue) => buf.push(c));
  const drain = () => {
    const out = buf;
    buf = [];
    return out;
  };

  const steps = COMMANDS.map((cmd) => {
    switch (cmd.kind) {
      case "startTurn":
        campaign.activeCharacter.startTurn();
        break;
      case "nextPlayer":
        campaign.nextPlayer();
        break;
    }
    return {
      command: cmd,
      cues: drain(),
      snapshot: serializeCampaign(campaign),
      view: viewProjected(campaign),
    };
  });
  return { start, steps };
}

// Load-bearing predicate: some step's snapshot has a character with a non-empty
// shakenOff — the whole reason this fixture exists.
function persistsShakenOff(steps: Step[]): boolean {
  return steps.some((s) => {
    const chars =
      (s.snapshot as { characters?: Array<{ afflictions?: { shakenOff?: unknown[] } }> })
        .characters ?? [];
    return chars.some((ch) => (ch.afflictions?.shakenOff?.length ?? 0) > 0);
  });
}

describe("generate affliction shake-off golden", () => {
  it("writes a golden whose snapshot persists a non-empty shakenOff", () => {
    let chosen: { seed: number; start: unknown; steps: Step[] } | null = null;
    for (let seed = 1; seed <= 200; seed++) {
      const { start, steps } = driveAndCapture(seed);
      if (persistsShakenOff(steps)) {
        chosen = { seed, start, steps };
        break;
      }
    }
    if (!chosen) {
      throw new Error(
        "No seed in 1..200 produced a persisted non-empty shakenOff — lengthen the stream.",
      );
    }
    // Redundant hard-throw guarding the coverage contract (see file header).
    if (!persistsShakenOff(chosen.steps)) {
      throw new Error("Chosen golden lacks a non-empty shakenOff (self-validation failed).");
    }

    const catalog = { items: {}, aliases: {} }; // no items → empty catalog

    writeFileSync(
      join(here, "affliction-shakeoff.start.snapshot.json"),
      JSON.stringify(chosen.start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "affliction-shakeoff.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "affliction-shakeoff.golden.json"),
      JSON.stringify({ seed: chosen.seed, commands: COMMANDS, steps: chosen.steps }, null, 2) + "\n",
    );

    console.log(`[affliction-shakeoff] SEED=${chosen.seed} steps=${chosen.steps.length}`);
  });
});
