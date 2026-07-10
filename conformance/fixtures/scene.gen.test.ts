/**
 * Scene golden generator — run once to write the committed fixture files.
 *
 * Proves scene enter/exit firing + persisted scene state end-to-end against
 * the Rust `conformance:visit-counter` `SceneBehavior`
 * (crates/wickedways-core/src/world/scenes.rs, compiled under
 * `--features conformance`, which the wasm build used by
 * `pnpm run test:conformance` enables). The TS shadow (scene-shadow.ts)
 * reproduces the Rust behavior byte-for-byte:
 *
 *   can_play:   state.count (default 0) < 3  AND  the room is occupied
 *   run_script: count = (state.count ?? 0) + 1; state.count = count;
 *               emit one cue: `The ${room.name} stirs (visit ${count}).`
 *
 * Map (exits auto-reverse — South returns):
 *   Foyer (lit, start room, NO scenes)
 *     ── North ──> Chamber (lit; enter-scene + exit-scene, both {count:0})
 *     ── North ──> Crypt   (lit; enter-scene + exit-scene, both {count:0})
 *
 * The start room is scene-free ON PURPOSE: `startSession` seats the PC via
 * `pc.move(startRoom)`, which plays enter scenes — a start-room scene would
 * fire during setup, before the first captured command. With Foyer scene-free
 * every scene mutation in the golden is caused by a captured command.
 *
 * Single PC "Mara"; maxRounds 10; baseEncounterChance 0; no formations →
 * no rng draws. Budget 3/round; the stream uses ≤2 budgeted `go`s per round
 * so no turn auto-ends mid-stream.
 *
 * Command stream (each `go` = 1 budgeted action):
 *   Round 0: startTurn; go N (Foyer→Chamber: Chamber.enter 0→1);
 *            go N (Chamber→Crypt: Chamber.exit 0→1, Crypt.enter 0→1, ordered
 *            exit-before-enter); nextPlayer (single-PC wrap → endRound → r1).
 *   Round 1: startTurn; go S (Crypt→Chamber: Crypt.exit 0→1, Chamber.enter 1→2);
 *            go N (Chamber→Crypt: Chamber.exit 1→2, Crypt.enter 1→2); nextPlayer.
 *   Round 2: startTurn; go S (Crypt.exit 1→2, Chamber.enter 2→3);
 *            go N (Chamber.exit 2→3, Crypt.enter 2→3); nextPlayer.
 *   Round 3: startTurn; go S (Crypt.exit 2→3; Chamber.enter capped at 3 → no
 *            fire); go N (Chamber.exit + Crypt.enter both capped → NO scene cues).
 *
 * Writes:
 *   - scene.start.snapshot.json   (serialized genesis state, pre-command)
 *   - scene.catalog.json          ({ items: {}, aliases: {} } — no items registered)
 *   - scene.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Seeded RNG: a single shared mulberry32(SEED) — no draws actually occur in
 * this stream (healthy PC, no formations registered, lit rooms), so any seed
 * yields the same golden; coverage is asserted with hard throws below.
 *
 * DEEP-COPY IS MANDATORY: `Scene[SERIALIZE]` (like `Exit`) returns `state` by
 * LIVE reference and the visit counts change every step — without
 * `structuralClone` at capture time every golden step would show the FINAL
 * counts. The start snapshot and every per-step snapshot/view are cloned.
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "go", "dir": "north"|"south" }
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
import type { SceneSnapshot } from "wickedways/lib/serialization/types";
import { visitCounterShadow, VISIT_COUNTER_KEY } from "./scene-shadow.ts";
import { structuralClone, viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Catalog ──────────────────────────────────────────────────────────────────
//
// This fixture registers NO items, so the catalog is empty on both sides
// (the Rust `Catalog` deserializes an empty `items` map — `Catalog::default()`
// is empty).
const EMPTY_CATALOG = { items: {}, aliases: {} };

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildSceneRegistry() {
  return defineRegistry({
    items: {},
    scenes: { [VISIT_COUNTER_KEY]: visitCounterShadow },
  });
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────

/**
 * Rooms: Foyer (lit, start, scene-free) → Chamber → Crypt, chained North with
 * auto-reversed South returns. Chamber and Crypt each carry BOTH an enter-scene
 * and an exit-scene of the `conformance:visit-counter` behavior, each with its
 * own independent `{count:0}` state.
 * Player: Mara (single PC). maxRounds 10 (headroom); baseEncounterChance 0 and
 * no formations → no rng draws on movement.
 */
function buildSceneCampaign(rng: () => number) {
  const registry = buildSceneRegistry();

  const template = authorTemplate("Scene (conformance)", registry, {
    rng,
    maxRounds: 10,
    baseEncounterChance: 0,
    now: () => 0,
  })
    .archetype({
      id: "delver",
      name: "Delver",
      baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 10 },
    })
    .room("Foyer", { description: "A dusty foyer." })
    .room("Chamber", { description: "A cold chamber." })
    .room("Crypt", { description: "A silent crypt." })
    .startRoom("Foyer")
    .exit("Foyer", Directions.North, "Chamber")
    .exit("Chamber", Directions.North, "Crypt")
    .scene("Chamber", VISIT_COUNTER_KEY, { phase: "enter", initialState: { count: 0 } })
    .scene("Chamber", VISIT_COUNTER_KEY, { phase: "exit", initialState: { count: 0 } })
    .scene("Crypt", VISIT_COUNTER_KEY, { phase: "enter", initialState: { count: 0 } })
    .scene("Crypt", VISIT_COUNTER_KEY, { phase: "exit", initialState: { count: 0 } });

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
  | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate scene golden", () => {
  it("writes the scene snapshot, catalog, and golden", () => {
    // Fixed seed: this stream draws NO rng (no formations, healthy PC, lit
    // rooms), so any seed yields the same golden. Coverage is asserted below
    // with hard throws instead of a seed search.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign } = buildSceneCampaign(rng);

    // ── Resolve live rooms + verify the map shape ────────────────────────────
    const foyer = campaign.activeCharacter.currentRoom!;
    if (foyer.name !== "Foyer") {
      throw new Error(`Expected PC to start in "Foyer", got "${foyer.name}"`);
    }
    const northFromFoyer = foyer.exits.get(Directions.North);
    if (!northFromFoyer) throw new Error("Foyer has no North exit.");
    const chamber = northFromFoyer.otherSide(foyer);
    if (chamber.name !== "Chamber") {
      throw new Error(`Foyer's North exit should reach "Chamber", got "${chamber.name}"`);
    }
    const northFromChamber = chamber.exits.get(Directions.North);
    if (!northFromChamber) throw new Error("Chamber has no North exit.");
    const crypt = northFromChamber.otherSide(chamber);
    if (crypt.name !== "Crypt") {
      throw new Error(`Chamber's North exit should reach "Crypt", got "${crypt.name}"`);
    }
    // Auto-reverse: the South returns traverse the SAME Exit objects.
    if (chamber.exits.get(Directions.South) !== northFromFoyer) {
      throw new Error("Chamber's South exit is not the auto-reversed Foyer North exit.");
    }
    if (crypt.exits.get(Directions.South) !== northFromChamber) {
      throw new Error("Crypt's South exit is not the auto-reversed Chamber North exit.");
    }

    // ── Genesis snapshot (pre-command state) ─────────────────────────────────
    // Deep-copy: Scene[SERIALIZE] returns `state` by live reference, and this
    // snapshot is written to disk AFTER the command stream advances the counts.
    const start = structuralClone(serializeCampaign(campaign));

    const startRoom = (name: string) => {
      const r = start.rooms.find((x) => x.name === name);
      if (!r) throw new Error(`Room "${name}" missing from the start snapshot.`);
      return r;
    };
    // Foyer MUST be scene-free (the setup pc.move(startRoom) fired no scene).
    if (startRoom("Foyer").scenes.length !== 0) {
      throw new Error(
        `Foyer must carry no scenes (start-room enter fires during setup), got ${startRoom("Foyer").scenes.length}`,
      );
    }
    // Chamber + Crypt each carry an enter- and an exit-scene, all at count 0.
    for (const name of ["Chamber", "Crypt"]) {
      const scenes = startRoom(name).scenes;
      if (scenes.length !== 2) {
        throw new Error(`${name} should carry 2 scenes at genesis, got ${scenes.length}`);
      }
      for (const phase of ["enter", "exit"] as const) {
        const s = scenes.find((x) => x.phase === phase);
        if (!s) throw new Error(`${name} is missing its "${phase}" scene at genesis.`);
        if (s.behaviorKey !== VISIT_COUNTER_KEY) {
          throw new Error(`${name}.${phase} scene behaviorKey should be "${VISIT_COUNTER_KEY}", got "${s.behaviorKey}"`);
        }
        if (s.state["count"] !== 0) {
          throw new Error(
            `${name}.${phase} scene should start at count 0, got ${JSON.stringify(s.state)}`,
          );
        }
      }
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
    // Budgeted: each successful go (1). Budget is 3/round — every round uses 2,
    // so no auto-end. nextPlayer on the single-PC party wraps → endRound.
    const commands: Command[] = [
      // Round 0: Foyer → Chamber → Crypt
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North }, // Foyer→Chamber: Chamber.enter 0→1
      { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 0→1, Crypt.enter 0→1 (ordered)
      { kind: "nextPlayer" },                // single-PC wrap → endRound → round 1
      // Round 1: Crypt → Chamber → Crypt
      { kind: "startTurn" },
      { kind: "go", dir: Directions.South }, // Crypt→Chamber: Crypt.exit 0→1, Chamber.enter 1→2
      { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 1→2, Crypt.enter 1→2
      { kind: "nextPlayer" },                // round 2
      // Round 2: Crypt → Chamber → Crypt
      { kind: "startTurn" },
      { kind: "go", dir: Directions.South }, // Crypt→Chamber: Crypt.exit 1→2, Chamber.enter 2→3
      { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 2→3, Crypt.enter 2→3
      { kind: "nextPlayer" },                // round 3
      // Round 3: cap reached — Chamber.enter/Crypt.enter/exit all at 3 → no fire, no cue
      { kind: "startTurn" },
      { kind: "go", dir: Directions.South }, // Crypt→Chamber: Crypt.exit 2→3, Chamber.enter 3 (capped: no fire)
      { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 3 (capped), Crypt.enter 3 (capped): NO scene cues
    ];

    // ── Drive the engine directly, capturing per-step state ──────────────────
    const pcNow = () => campaign.activeCharacter;

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "nextPlayer":
          campaign.nextPlayer();
          break;
        case "go":
          pcNow().go(cmd.dir);
          break;
      }
      // Deep-copy at capture time: Scene[SERIALIZE] returns `state` by live
      // reference, so without a copy every step would retroactively show the
      // FINAL visit counts.
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

    // Exact ordered scene-cue texts per step (exit scenes of the departed room
    // fire BEFORE enter scenes of the destination).
    expectMechanicTexts(0, []);
    expectMechanicTexts(1, ["The Chamber stirs (visit 1)."]);
    expectMechanicTexts(2, ["The Chamber stirs (visit 1).", "The Crypt stirs (visit 1)."]);
    expectMechanicTexts(3, []);
    expectMechanicTexts(4, []);
    expectMechanicTexts(5, ["The Crypt stirs (visit 1).", "The Chamber stirs (visit 2)."]);
    expectMechanicTexts(6, ["The Chamber stirs (visit 2).", "The Crypt stirs (visit 2)."]);
    expectMechanicTexts(7, []);
    expectMechanicTexts(8, []);
    expectMechanicTexts(9, ["The Crypt stirs (visit 2).", "The Chamber stirs (visit 3)."]);
    expectMechanicTexts(10, ["The Chamber stirs (visit 3).", "The Crypt stirs (visit 3)."]);
    expectMechanicTexts(11, []);
    expectMechanicTexts(12, []);
    expectMechanicTexts(13, ["The Crypt stirs (visit 3)."]); // Chamber.enter capped at 3 → no cue
    expectMechanicTexts(14, []);                             // Chamber.exit + Crypt.enter both capped

    // Final per-room scene counts, read from the FINAL step's snapshot:
    // Chamber.enter = 3, Chamber.exit = 3, Crypt.enter = 3, Crypt.exit = 3.
    const finalSnapshot = steps[steps.length - 1]!.snapshot;
    const finalSceneCount = (roomName: string, phase: "enter" | "exit"): unknown => {
      const room = finalSnapshot.rooms.find((r) => r.name === roomName);
      if (!room) throw new Error(`Room "${roomName}" missing from the final snapshot.`);
      const scene: SceneSnapshot | undefined = room.scenes.find((s) => s.phase === phase);
      if (!scene) throw new Error(`${roomName} is missing its "${phase}" scene in the final snapshot.`);
      return scene.state["count"];
    };
    for (const [roomName, phase] of [
      ["Chamber", "enter"],
      ["Chamber", "exit"],
      ["Crypt", "enter"],
      ["Crypt", "exit"],
    ] as const) {
      const got = finalSceneCount(roomName, phase);
      if (got !== 3) {
        throw new Error(`Final ${roomName}.${phase} scene count should be 3, got ${String(got)}`);
      }
    }

    // Per-step deep-copy proof: step 1's Chamber.enter count must still be 1
    // in the written golden (a live-reference capture would show 3).
    const step1Chamber = steps[1]!.snapshot.rooms.find((r) => r.name === "Chamber");
    const step1Enter = step1Chamber?.scenes.find((s) => s.phase === "enter");
    if (step1Enter?.state["count"] !== 1) {
      throw new Error(
        `Step 1 Chamber.enter count should be 1 (deep-copy at capture), got ${JSON.stringify(step1Enter?.state)}`,
      );
    }

    // ── Write files ──────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "scene.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "scene.catalog.json"),
      JSON.stringify(EMPTY_CATALOG, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "scene.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ────────────────────────────────────────────────────────
    console.log(`[scene] SEED=${SEED} steps=${steps.length}`);
  });
});
