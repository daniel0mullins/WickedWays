/**
 * victory-timeout golden generator — run once to write the committed fixtures.
 *
 * Two-player campaign with NO win/lose conditions, maxRounds 2, and a timeout
 * narration (.onTimeout). Command stream 4× nextPlayer: round 0→1 (ongoing,
 * 1<2), 1→2 (round 2 == maxRounds, no condition → timed-out with the timeout
 * narration on the cue).
 *
 * Writes victory-timeout.{start.snapshot,catalog,golden}.json.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildSeedRegistry } from "../../packages/seed/src/index.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { PresentationCue } from "wickedways/lib/presentation";
import { mulberry32 } from "../seeded-rng.ts";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x7104;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "nextPlayer" };

describe("generate victory-timeout golden", () => {
  it("writes the booted snapshot + per-step golden (timed-out at maxRounds)", () => {
    const registry = buildSeedRegistry();

    const template = authorTemplate("Victory Timeout (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 2,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .onTimeout({ text: "Time's up." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    if (campaign.maxRounds !== 2) throw new Error(`expected maxRounds 2, got ${campaign.maxRounds}`);

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-timeout.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 1 (ongoing)
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 2 == max (timed-out)
    ];
    const steps = commands.map((cmd) => {
      campaign.nextPlayer();
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "timed-out")
      throw new Error(`expected outcome "timed-out", got "${res.outcome}"`);
    if (res.kind === "resolution" && res.narration?.text !== "Time's up.")
      throw new Error(`expected timeout narration, got ${JSON.stringify(res.narration)}`);

    writeFileSync(join(here, "victory-timeout.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-timeout.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
