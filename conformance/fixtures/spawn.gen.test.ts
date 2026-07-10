/**
 * Encounter-spawn golden generator — run once to write the committed fixture files.
 *
 * Proves `EncounterTable.maybeSpawn` end-to-end against the Rust
 * `conformance:wraith` `FormationBehavior` + `World::maybe_spawn`
 * (crates/wickedways-core/src/world/formations.rs, compiled under
 * `--features conformance`, which the wasm build used by
 * `pnpm run test:conformance` enables). The TS shadow (formation-shadow.ts)
 * reproduces the Rust `build_wraith` byte-for-byte; the Crypt reuses the
 * `conformance:visit-counter` scene shadow to prove SILENT enter-scene firing
 * on spawn placement.
 *
 * Map (exit auto-reverses — South returns):
 *   Foyer (lit, start room, NO scenes, spawnModifier 0)
 *     ── North ──> Crypt (lit; ONE enter-scene, {count:0}; spawnModifier 1)
 *
 * The start room is scene-free ON PURPOSE (startSession seats the PC via
 * `pc.move(startRoom)`, which plays enter scenes) AND carries `spawnModifier: 0`
 * ON PURPOSE: that same setup `pc.move` runs `campaign.maybeSpawn(Foyer)`, and
 * with `baseEncounterChance: 100` a default spawnModifier of 1 would spawn the
 * Wraith in the FOYER during setup — before the first captured command — and the
 * later Crypt spawn would then collide on the deterministic mob id. With
 * spawnModifier 0 the Foyer threshold is clamp(100*0)=0 and roll(100) ≥ 1 > 0
 * never spawns, for ANY seed. The setup check still marks Foyer visited (and
 * consumes one pre-snapshot rng draw — harmless: every post-snapshot outcome in
 * this stream is roll-value-independent, see below).
 *
 * Crypt spawn math: threshold = clamp(baseChance 100 × spawnModifier 1) = 100,
 * and roll(100) ≤ 100 ALWAYS → guaranteed, seed-independent spawn. The weighted
 * select over the single weight-1 formation is roll(1) = 1 → also seed-independent.
 *
 * Command stream (single PC "Mara"; budget 3/round):
 *   Round 0: startTurn;
 *     go N (Foyer→Crypt: PC entry fires Crypt.enter — cue "visit 1", count 0→1;
 *           after record_action: maybeSpawn spawns the Wraith (roll 100 ≤ 100),
 *           whose [PLACE] fires Crypt.enter AGAIN but SILENTLY (count 1→2, NO
 *           cue); then NOTE_ENCOUNTERS emits ONE encounter cue for the Wraith,
 *           after the move action cue);
 *     go S (Crypt→Foyer: Foyer already visited → no spawn check roll, no cues);
 *     go N (Foyer→Crypt again: Crypt.enter fires — cue "visit 3", count 2→3;
 *           third budgeted action reaches the 3/round cap → record_action
 *           auto-ends the turn (no mechanics registered → silent turn-end);
 *           Crypt already visited → NO second spawn; Wraith already
 *           encountered → NO second encounter cue (per-character dedup)).
 *
 * Writes:
 *   - spawn.start.snapshot.json   (serialized genesis state, pre-command)
 *   - spawn.catalog.json          ({ items: {}, aliases: {} } — no items registered)
 *   - spawn.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Seeded RNG: a single shared mulberry32(SEED). Draws DO occur (setup Foyer
 * threshold roll pre-snapshot; Crypt threshold + weighted-select rolls at step 1)
 * but every outcome is roll-value-independent (thresholds 0 and 100; a single
 * weight-1 formation), so any seed yields the same golden. Coverage is asserted
 * with hard throws below.
 *
 * DEEP-COPY IS MANDATORY: `Scene[SERIALIZE]` returns `state` by LIVE reference
 * (the Crypt visit count mutates every entry) and the spawned Wraith mutates the
 * world across steps — the start snapshot and every per-step snapshot/view are
 * captured through `structuralClone`.
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "go", "dir": "north"|"south" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { CharacterSnapshot } from "wickedways/lib/serialization/types";
import { visitCounterShadow, VISIT_COUNTER_KEY } from "./scene-shadow.ts";
import { wraithFormationShadow, WRAITH_KEY, WRAITH_ID } from "./formation-shadow.ts";
import { structuralClone, viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Catalog ──────────────────────────────────────────────────────────────────
//
// This fixture registers NO items, so the catalog is empty on both sides
// (the Rust `Catalog` deserializes an empty `items` map — `Catalog::default()`
// is empty).
const EMPTY_CATALOG = { items: {}, aliases: {} };

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildSpawnRegistry() {
  return defineRegistry({
    items: {},
    scenes: { [VISIT_COUNTER_KEY]: visitCounterShadow },
    formations: { [WRAITH_KEY]: wraithFormationShadow },
  });
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────

/**
 * Rooms: Foyer (lit, start, scene-free, spawnModifier 0 — see the header note)
 * → North → Crypt (lit, ONE enter-scene, default spawnModifier 1), auto-reversed
 * South return. One roving formation: the conformance Wraith at weight 1.
 * Player: Mara (single PC). maxRounds 10 (headroom); baseEncounterChance 100 →
 * the Crypt threshold is 100 (guaranteed spawn), the Foyer threshold is 0
 * (guaranteed non-spawn at setup).
 */
function buildSpawnCampaign(rng: () => number) {
  const registry = buildSpawnRegistry();

  const template = authorTemplate("Spawn (conformance)", registry, {
    rng,
    maxRounds: 10,
    baseEncounterChance: 100,
    now: () => 0,
  })
    .archetype({
      id: "delver",
      name: "Delver",
      baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 10 },
    })
    .room("Foyer", { description: "A dusty foyer.", spawnModifier: 0 })
    .room("Crypt", { description: "A silent crypt." })
    .startRoom("Foyer")
    .exit("Foyer", Directions.North, "Crypt")
    .scene("Crypt", VISIT_COUNTER_KEY, { phase: "enter", initialState: { count: 0 } })
    .formation(WRAITH_KEY, { weight: 1 });

  const campaign = startSession(template, {
    players: [{ name: "Mara", archetype: "delver" }],
    gm: 0,
  });

  return { campaign, registry };
}

// ─── Command types ─────────────────────────────────────────────────────────────
//
// Each stored command serializes to exactly the Rust `Command` shape.

type Command =
  | { kind: "startTurn" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate spawn golden", () => {
  it("writes the spawn snapshot, catalog, and golden", () => {
    // Fixed seed: draws occur but every outcome is roll-value-independent
    // (thresholds 0 and 100; single weight-1 formation), so any seed yields the
    // same golden. Coverage is asserted below with hard throws.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign } = buildSpawnCampaign(rng);

    // ── Resolve live rooms + verify the map shape ────────────────────────────
    const foyer = campaign.activeCharacter.currentRoom!;
    if (foyer.name !== "Foyer") {
      throw new Error(`Expected PC to start in "Foyer", got "${foyer.name}"`);
    }
    const FOYER_ID = foyer.id as unknown as string;
    const northExit = foyer.exits.get(Directions.North);
    if (!northExit) throw new Error("Foyer has no North exit.");
    const crypt = northExit.otherSide(foyer);
    if (crypt.name !== "Crypt") {
      throw new Error(`Foyer's North exit should reach "Crypt", got "${crypt.name}"`);
    }
    const CRYPT_ID = crypt.id as unknown as string;
    if (crypt.exits.get(Directions.South) !== northExit) {
      throw new Error("Crypt's South exit is not the auto-reversed Foyer North exit.");
    }
    // Spawn thresholds this fixture's math depends on.
    if (foyer.spawnModifier !== 0) {
      throw new Error(`Foyer spawnModifier must be 0 (no setup spawn), got ${foyer.spawnModifier}`);
    }
    if (crypt.spawnModifier !== 1) {
      throw new Error(`Crypt spawnModifier must be 1 (threshold 100), got ${crypt.spawnModifier}`);
    }

    // ── Genesis snapshot (pre-command state) ─────────────────────────────────
    // Deep-copy: Scene[SERIALIZE] returns `state` by live reference, and this
    // snapshot is written to disk AFTER the command stream advances the count.
    const start = structuralClone(serializeCampaign(campaign));

    // Foyer MUST be scene-free (the setup pc.move(startRoom) fired no scene).
    const startFoyer = start.rooms.find((r) => r.name === "Foyer");
    if (!startFoyer) throw new Error("Foyer missing from the start snapshot.");
    if (startFoyer.scenes.length !== 0) {
      throw new Error(`Foyer must carry no scenes, got ${startFoyer.scenes.length}`);
    }
    // Crypt carries exactly ONE enter-scene at count 0.
    const startCrypt = start.rooms.find((r) => r.name === "Crypt");
    if (!startCrypt) throw new Error("Crypt missing from the start snapshot.");
    if (startCrypt.scenes.length !== 1) {
      throw new Error(`Crypt should carry 1 scene at genesis, got ${startCrypt.scenes.length}`);
    }
    const startScene = startCrypt.scenes[0]!;
    if (startScene.phase !== "enter" || startScene.behaviorKey !== VISIT_COUNTER_KEY) {
      throw new Error(
        `Crypt's scene should be an "${VISIT_COUNTER_KEY}" enter-scene, got ${startScene.phase}/${startScene.behaviorKey}`,
      );
    }
    if (startScene.state["count"] !== 0) {
      throw new Error(`Crypt enter-scene should start at count 0, got ${JSON.stringify(startScene.state)}`);
    }
    // Encounter table at genesis: base 100, ONE weight-1 wraith formation, and
    // ONLY the Foyer visited (setup seating consumed its first-visit check
    // without spawning — threshold 0).
    const et = start.campaign.encounterTable;
    if (et.baseChance !== 100) {
      throw new Error(`encounterTable.baseChance should be 100, got ${et.baseChance}`);
    }
    if (JSON.stringify(et.formations) !== JSON.stringify([{ behaviorKey: WRAITH_KEY, weight: 1 }])) {
      throw new Error(`encounterTable.formations mismatch: ${JSON.stringify(et.formations)}`);
    }
    if (JSON.stringify(et.visited) !== JSON.stringify([FOYER_ID])) {
      throw new Error(
        `encounterTable.visited should be exactly ["${FOYER_ID}"] at genesis, got ${JSON.stringify(et.visited)}`,
      );
    }
    // NO wraith at genesis (the Foyer setup check must not have spawned).
    if (start.characters.some((c) => c.id === WRAITH_ID)) {
      throw new Error("Wraith must NOT exist at genesis (setup spawn in the Foyer).");
    }
    if (start.characters.length !== 1) {
      throw new Error(`Start snapshot should hold only Mara, got ${start.characters.length} characters.`);
    }

    // ── Cue capture (drain buffer) ───────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── The deterministic command stream ─────────────────────────────────────
    //
    // Budgeted: each successful go (1). The third go exactly reaches the
    // 3/round cap → its record_action auto-ends the turn (no mechanics
    // registered → the turn-end is silent), BEFORE maybeSpawn/NOTE_ENCOUNTERS.
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North }, // Foyer→Crypt: enter cue "visit 1"; SILENT spawn placement (count→2); encounter cue
      { kind: "go", dir: Directions.South }, // Crypt→Foyer: visited → no spawn roll; no cues
      { kind: "go", dir: Directions.North }, // Foyer→Crypt: enter cue "visit 3"; NO second spawn; NO second encounter cue
    ];

    // ── Drive the engine directly, capturing per-step state ──────────────────
    const pcNow = () => campaign.activeCharacter;

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "go":
          pcNow().go(cmd.dir);
          break;
      }
      // Deep-copy at capture time: Scene[SERIALIZE] returns `state` by live
      // reference (and the spawned Wraith mutates the world), so without a copy
      // earlier steps would retroactively show FINAL state.
      return {
        command: cmd,
        cues: drain(),
        snapshot: structuralClone(serializeCampaign(campaign)),
        view: structuralClone(viewProjected(campaign)),
      };
    });

    // ── Self-validation (hard throws — the stream is deterministic) ──────────

    const mechanicTexts = (step: (typeof steps)[number]): string[] =>
      step.cues
        .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
        .map((c) => c.cue.text ?? "");

    const expectMechanicTexts = (i: number, want: string[]) => {
      const got = mechanicTexts(steps[i]!);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(
          `Step ${i} mechanic cues mismatch: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
        );
      }
    };

    const encounterCues = (i: number) =>
      steps[i]!.cues.filter(
        (c): c is Extract<PresentationCue, { kind: "encounter" }> => c.kind === "encounter",
      );

    const wraithIn = (i: number): CharacterSnapshot | undefined =>
      steps[i]!.snapshot.characters.find((c) => c.id === WRAITH_ID);

    const cryptEnterCount = (i: number): unknown => {
      const room = steps[i]!.snapshot.rooms.find((r) => r.name === "Crypt");
      if (!room) throw new Error(`Crypt missing from step ${i} snapshot.`);
      const scene = room.scenes.find((s) => s.phase === "enter");
      if (!scene) throw new Error(`Crypt enter-scene missing from step ${i} snapshot.`);
      return scene.state["count"];
    };

    // (a) startTurn: no mechanic cues, no encounter cues, no wraith yet.
    expectMechanicTexts(0, []);
    if (encounterCues(0).length !== 0) throw new Error("Step 0 should emit no encounter cues.");
    if (wraithIn(0)) throw new Error("Step 0: the Wraith must not exist before the first go.");

    // (b) First entry into the Crypt: EXACTLY ONE scene cue ("visit 1") — the
    //     spawn placement's re-fire is SILENT (count 1→2, no "visit 2" cue).
    expectMechanicTexts(1, ["The Crypt stirs (visit 1)."]);
    if (cryptEnterCount(1) !== 2) {
      throw new Error(
        `Step 1: Crypt enter-scene count should be 2 (PC entry + silent spawn placement), got ${String(cryptEnterCount(1))}`,
      );
    }
    //     ONE encounter cue for the Wraith, AFTER the move action cue.
    const step1Encounters = encounterCues(1);
    if (step1Encounters.length !== 1) {
      throw new Error(`Step 1 should emit exactly 1 encounter cue, got ${step1Encounters.length}`);
    }
    const enc = step1Encounters[0]!;
    if (enc.mob.id !== WRAITH_ID || enc.mob.name !== "Wraith") {
      throw new Error(`Step 1 encounter cue should reference the Wraith, got ${JSON.stringify(enc.mob)}`);
    }
    if (enc.room.id !== CRYPT_ID) {
      throw new Error(`Step 1 encounter cue should reference the Crypt, got ${JSON.stringify(enc.room)}`);
    }
    const moveIdx = steps[1]!.cues.findIndex((c) => c.kind === "action" && c.action === "move");
    const encIdx = steps[1]!.cues.findIndex((c) => c.kind === "encounter");
    if (moveIdx === -1) throw new Error("Step 1 is missing its move action cue.");
    if (encIdx < moveIdx) {
      throw new Error(`Step 1 encounter cue must come after the move action cue (move@${moveIdx}, encounter@${encIdx}).`);
    }
    //     The Wraith exists, campaign-origin, seated in the Crypt.
    const wraith1 = wraithIn(1);
    if (!wraith1) throw new Error("Step 1: the Wraith is missing from the snapshot characters.");
    if (wraith1.origin !== "campaign") {
      throw new Error(`Step 1: Wraith origin should be "campaign", got ${JSON.stringify(wraith1.origin)}`);
    }
    if (wraith1.currentRoomId !== CRYPT_ID) {
      throw new Error(`Step 1: Wraith should be in the Crypt, got room ${String(wraith1.currentRoomId)}`);
    }
    const crypt1 = steps[1]!.snapshot.rooms.find((r) => r.name === "Crypt")!;
    if (crypt1.occupantIds.filter((id) => id === WRAITH_ID).length !== 1) {
      throw new Error(`Step 1: Crypt occupantIds should list the Wraith exactly once, got ${JSON.stringify(crypt1.occupantIds)}`);
    }
    //     The Crypt is now marked visited (Foyer + Crypt, in visit order).
    if (JSON.stringify(steps[1]!.snapshot.campaign.encounterTable.visited) !== JSON.stringify([FOYER_ID, CRYPT_ID])) {
      throw new Error(
        `Step 1 visited should be [Foyer, Crypt], got ${JSON.stringify(steps[1]!.snapshot.campaign.encounterTable.visited)}`,
      );
    }
    //     The Wraith surfaces in the step-1 view occupants.
    if (!(steps[1]!.view.occupants as Array<{ name?: unknown }>).some((o) => o.name === "Wraith")) {
      throw new Error("Step 1: the Wraith never surfaced in view.occupants.");
    }

    // (c) Return to the Foyer: visited → no spawn roll; no scene (Foyer is
    //     scene-free, the Crypt has no exit-scene); no encounter cues.
    expectMechanicTexts(2, []);
    if (encounterCues(2).length !== 0) throw new Error("Step 2 should emit no encounter cues.");

    // (d) Re-entry into the Crypt: the enter-scene fires once more (count 2→3,
    //     cue "visit 3") — but NO second spawn (first-visit-only) and NO second
    //     encounter cue (per-character dedup). Turn-end at the budget cap is
    //     silent (no mechanics registered).
    expectMechanicTexts(3, ["The Crypt stirs (visit 3)."]);
    if (encounterCues(3).length !== 0) {
      throw new Error("Step 3 should emit no encounter cue (the Wraith is already encountered).");
    }
    if (steps[3]!.snapshot.characters.filter((c) => c.id === WRAITH_ID).length !== 1) {
      throw new Error("Step 3: exactly one Wraith must exist (no second spawn).");
    }
    if (steps[3]!.snapshot.characters.length !== 2) {
      throw new Error(
        `Step 3: snapshot should hold exactly Mara + the Wraith, got ${steps[3]!.snapshot.characters.length} characters.`,
      );
    }
    const crypt3 = steps[3]!.snapshot.rooms.find((r) => r.name === "Crypt")!;
    if (crypt3.occupantIds.filter((id) => id === WRAITH_ID).length !== 1) {
      throw new Error(`Step 3: Crypt occupantIds should still list the Wraith exactly once, got ${JSON.stringify(crypt3.occupantIds)}`);
    }
    // Pin the exact final scene count: 1 (PC entry) + 1 (silent placement) + 1
    // (re-entry) = 3.
    if (cryptEnterCount(3) !== 3) {
      throw new Error(`Step 3: final Crypt enter-scene count should be 3, got ${String(cryptEnterCount(3))}`);
    }

    // Per-step deep-copy proof: step 1's recorded count must still be 2 after
    // step 3 advanced the live state to 3.
    if (cryptEnterCount(1) !== 2) {
      throw new Error("Deep-copy failure: step 1's Crypt count was retroactively mutated.");
    }
    // And the genesis snapshot must still show count 0 / no wraith.
    if (startScene.state["count"] !== 0) {
      throw new Error("Deep-copy failure: the start snapshot's Crypt count was retroactively mutated.");
    }

    // ── Write files ──────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "spawn.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "spawn.catalog.json"),
      JSON.stringify(EMPTY_CATALOG, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "spawn.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ────────────────────────────────────────────────────────
    console.log(`[spawn] SEED=${SEED} foyer=${FOYER_ID} crypt=${CRYPT_ID} steps=${steps.length}`);
  });
});
