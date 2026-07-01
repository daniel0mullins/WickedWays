/**
 * Turn-movement golden generator — run once to write the committed fixture files.
 *
 * Uses a bespoke inline campaign (NOT the shared seed campaign from packages/seed)
 * so we can add a dark "Cellar" room without disturbing the shared seed fixture.
 * Two players: Ada (active) and Ben. Rooms: Start (lit, start), Next (lit),
 * Cellar (dark: true, reachable from Start via South).
 *
 * Writes:
 *   - turn-movement.start.snapshot.json  (serialized booted state)
 *   - turn-movement.golden.json          (commands + per-step cues/snapshots/view)
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * The main test:conformance gate excludes conformance/fixtures/** so this
 * generator never runs as part of the replay gate (prevents the self-referential
 * regeneration bug from sub-plan 1).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedRegistry } from "../../packages/seed/src/index.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Empty catalog — the turn-movement campaign has no items.
const EMPTY_ALIASES: Record<string, string[]> = {};
const EMPTY_CATALOG = { items: {}, aliases: {} };

/**
 * Project the full TS ViewModel to the exact Rust 4a ViewModel subset.
 *
 * Remove:
 *   - top-level `exits` and `lockedDoors`
 *   - `status.locationName`
 *   - `room.image`
 *
 * `defeated` is now kept (Rust 4a emits it on occupant/character entities).
 *
 * Mirrors the `viewProjected` helper in items-projection.gen.test.ts.
 */
function viewProjected(campaign: Campaign) {
  const full = view(campaign, EMPTY_ALIASES, new Set());

  // Project room: remove image
  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };

  // Project status: remove locationName
  const { locationName: _locName, ...statusRest } = full.status as { locationName?: unknown; [k: string]: unknown };

  return {
    room: roomRest,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: statusRest,
    outcome: full.outcome,
    finished: full.finished,
  };
}

/**
 * Bespoke campaign for the differential conformance gate.
 *
 * Rooms:
 *   - Start  (lit, start room) — exits: North→Next, South→Cellar
 *   - Next   (lit)             — exits: South→Start
 *   - Cellar (dark: true)      — exits: North→Start
 *
 * Registry: reuses buildSeedRegistry() (provides the delver archetype, widget
 * recipe, and materials) — the archetype id "delver" must exist.
 * Players: Ada (active), Ben.
 * rng: () => 0.5, maxRounds: 10 (determinism + reachable timeout).
 */
function buildBespokeCampaign() {
  const registry = buildSeedRegistry();
  const template = authorTemplate("Crypt (conformance)", registry, { rng: () => 0.5, maxRounds: 10 })
    .archetype({ id: "delver", name: "Delver", baseStats: {} })
    .room("Start", { description: "the entrance" })
    .room("Next", { description: "an adjoining chamber" })
    .room("Cellar", { description: "a pitch-black cellar", dark: true })
    .startRoom("Start")
    .exit("Start", Directions.North, "Next")
    .exit("Next", Directions.South, "Start")
    .exit("Start", Directions.South, "Cellar")
    .exit("Cellar", Directions.North, "Start");

  const campaign = startSession(template, {
    players: [
      { name: "Ada", archetype: "delver" },
      { name: "Ben", archetype: "delver" },
    ],
    gm: 0,
  });
  return { campaign, registry };
}

describe("generate turn-movement golden", () => {
  it("writes the booted-seed snapshot + per-step golden", () => {
    // -------------------------------------------------------------------------
    // Boot the bespoke campaign. Two players: Ada (active) and Ben.
    // Both start in "Start". Round 0, maxRounds 10.
    // -------------------------------------------------------------------------
    const { campaign } = buildBespokeCampaign();

    // Verify boot invariants (these assertions document the oracle state).
    const bootPc = campaign.activeCharacter;
    if (bootPc.currentRoom.name !== "Start") {
      throw new Error(
        `Expected PC to start in "Start", got "${bootPc.currentRoom.name}"`,
      );
    }
    if (campaign.round !== 0) {
      throw new Error(`Expected round 0 at boot, got ${campaign.round}`);
    }
    if (campaign.maxRounds !== 10) {
      throw new Error(
        `Expected maxRounds 10, got ${campaign.maxRounds}`,
      );
    }

    // Write the booted snapshot (pre-command state).
    const start = serializeCampaign(campaign);
    writeFileSync(
      join(here, "turn-movement.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );

    // -------------------------------------------------------------------------
    // Set up cue capture.
    // -------------------------------------------------------------------------
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // -------------------------------------------------------------------------
    // Deterministic command stream.
    //
    // Party has 2 members (Ada + Ben). Each round requires 2 nextPlayer() calls.
    // Starting at round 0, maxRounds 10: 20 nextPlayer() calls reach round 10.
    // The 20th nextPlayer() triggers endRound() → resolveOutcome → timed-out.
    //
    // Turn 1 (Ada's turn, round 0):
    //   startTurn
    //   go South  (Start→Cellar, dark room → cues: [visibility{lit:false}, action{move}])
    //   go North  (Cellar→Start, lit room  → cues: [action{move}])
    //   go East   (wall → "You can't go that way." mechanic cue)
    //   nextPlayer()  → advance to Ben (still round 0)
    //
    // Ben's turn (round 0):
    //   startTurn
    //   nextPlayer()  → endRound → round 1
    //
    // Rounds 1–9: both Ada and Ben each do startTurn + nextPlayer() per turn.
    // The 20th nextPlayer() (Ben in round 9 → wraps to round 10) is timed-out.
    // -------------------------------------------------------------------------
    type Command =
      | { kind: "startTurn" }
      | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
      | { kind: "nextPlayer" };

    const commands: Command[] = [
      // Round 0, Ada's turn
      { kind: "startTurn" },
      { kind: "go", dir: Directions.South }, // Start → Cellar (dark! → visibility{lit:false} + action)
      { kind: "go", dir: Directions.North }, // Cellar → Start (lit → action only)
      { kind: "go", dir: Directions.East },  // wall → "You can't go that way." mechanic cue
      { kind: "nextPlayer" }, // Ada done → advance to Ben (still round 0)

      // Round 0, Ben's turn
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // Ben done → endRound → round 1

      // Rounds 1–9: both Ada and Ben each startTurn + nextPlayer (18 more nextPlayer calls)
      // Round 1 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 1 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 2

      // Round 2 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 2 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 3

      // Round 3 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 3 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 4

      // Round 4 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 4 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 5

      // Round 5 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 5 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 6

      // Round 6 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 6 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 7

      // Round 7 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 7 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 8

      // Round 8 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 8 Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 9

      // Round 9 Ada
      { kind: "startTurn" },
      { kind: "nextPlayer" },
      // Round 9 Ben — this nextPlayer() triggers endRound() → round 10 → timed-out
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // ← FINAL COMMAND: timeout landing here
    ];

    // -------------------------------------------------------------------------
    // Execute and capture.
    // -------------------------------------------------------------------------
    const pc = () => campaign.activeCharacter;
    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pc().startTurn();
          break;
        case "go":
          pc().go(cmd.dir);
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

    // -------------------------------------------------------------------------
    // Verify the final step landed the timeout cue.
    // -------------------------------------------------------------------------
    const lastStep = steps[steps.length - 1];
    if (!lastStep) throw new Error("No steps were generated");

    const finalCues = lastStep.cues;
    const resolutionCue = finalCues.find((c) => c.kind === "resolution");
    if (!resolutionCue) {
      throw new Error(
        `Expected a "resolution" cue on the final step but got: ${JSON.stringify(finalCues)}`,
      );
    }
    if (resolutionCue.kind === "resolution" && resolutionCue.outcome !== "timed-out") {
      throw new Error(
        `Expected outcome "timed-out" but got "${resolutionCue.outcome}"`,
      );
    }
    if (campaign.round !== campaign.maxRounds) {
      throw new Error(
        `Expected round ${campaign.maxRounds} after timeout, got ${campaign.round}`,
      );
    }

    // -------------------------------------------------------------------------
    // Verify dark-room coverage: at least one step must have a visibility cue
    // with lit:false (proves the Cellar entry was captured in the golden).
    // -------------------------------------------------------------------------
    const hasVisibilityDark = steps.some((step) =>
      step.cues.some(
        (c) => c.kind === "visibility" && !c.lit,
      ),
    );
    if (!hasVisibilityDark) {
      throw new Error(
        'Expected at least one step with a {kind:"visibility", lit:false} cue ' +
        "(dark-room coverage). Check that the Cellar room has dark:true and " +
        "the South exit from Start reaches it.",
      );
    }

    // -------------------------------------------------------------------------
    // Write the golden.
    // -------------------------------------------------------------------------
    writeFileSync(
      join(here, "turn-movement.catalog.json"),
      JSON.stringify(EMPTY_CATALOG, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "turn-movement.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );
  });
});
