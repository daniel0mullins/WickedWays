/**
 * Turn-movement golden generator — run once to write the committed fixture files.
 *
 * Boots the seed campaign (Ada + Ben, Start↔Next via North), drives a
 * deterministic command stream through the engine directly, and writes:
 *   - turn-movement.start.snapshot.json  (serialized booted-seed state)
 *   - turn-movement.golden.json          (commands + per-step cues/snapshots/viewThin)
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
import { buildSeedCampaign } from "../../packages/seed/src/index.ts";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Thin-view projection mirroring the Rust ThinViewModel shape (Task 5):
 *   { room: {id,name,description,isLit}, occupants: [...], status: {turn,maxTurns}, outcome, finished }
 * Active character is excluded from occupants.
 */
function viewThin(campaign: Campaign) {
  const pc = campaign.activeCharacter;
  const room = pc.currentRoom;
  return {
    room: {
      id: room.id,
      name: room.name,
      description: room.description,
      isLit: room.isLit,
    },
    occupants: room.occupants
      .filter((o) => o.id !== pc.id)
      .map((o) => ({ id: o.id, name: o.name, kind: "occupant" as const })),
    status: { turn: campaign.round, maxTurns: campaign.maxRounds },
    outcome: campaign.outcome,
    finished: campaign.finished,
  };
}

describe("generate turn-movement golden", () => {
  it("writes the booted-seed snapshot + per-step golden", () => {
    // -------------------------------------------------------------------------
    // Boot the seed campaign. Two players: Ada (active) and Ben.
    // Both start in "Start". Round 0, maxRounds 10.
    // -------------------------------------------------------------------------
    const { campaign } = buildSeedCampaign();

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

    // Write the booted-seed snapshot (pre-command state).
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
    // Turn 1 (Ada's turn): startTurn, go North (Start→Next), go South (Next→Start),
    //   go East (wall → mechanic "You can't go that way."), then nextPlayer().
    // Ben's turn: startTurn, nextPlayer() — Ben acts and ends the round → round 1.
    // Rounds 2–10: Ada startTurn + nextPlayer(), Ben startTurn + nextPlayer() each round.
    //   The final nextPlayer() (Ben in round 9 → wraps to round 10) is timed-out.
    // -------------------------------------------------------------------------
    type Command =
      | { kind: "startTurn" }
      | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
      | { kind: "nextPlayer" };

    const commands: Command[] = [
      // Round 0, Ada's turn
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North }, // Start → Next (action cue)
      { kind: "go", dir: Directions.South }, // Next → Start (action cue)
      { kind: "go", dir: Directions.East }, // wall → "You can't go that way." mechanic cue
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
        viewThin: viewThin(campaign),
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
    // Write the golden.
    // -------------------------------------------------------------------------
    writeFileSync(
      join(here, "turn-movement.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );
  });
});
