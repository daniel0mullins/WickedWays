/**
 * victory-won golden generator — run once to write the committed fixture files.
 *
 * Two-player bespoke campaign (Ada + Ben, gm 0) with a registered win condition
 * `conformance:round-reached` (fires at round >= 2). maxRounds 10 keeps the
 * timeout ceiling far, so the win fires on its own predicate at round 2, NOT via
 * the ceiling. Command stream: 4× nextPlayer (round 0→1 ongoing, 1→2 → won).
 *
 * Draws NO rng (no formations, healthy PCs, no combat, no movement), so any seed
 * yields the same golden.
 *
 * Writes:
 *   - victory-won.start.snapshot.json
 *   - victory-won.catalog.json  (empty)
 *   - victory-won.golden.json   ({ seed, commands, steps })
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
import { ROUND_REACHED_KEY, roundReached } from "./victory-shadow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x7e57;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "nextPlayer" };

describe("generate victory-won golden", () => {
  it("writes the booted snapshot + per-step golden (won at round 2)", () => {
    const registry = buildSeedRegistry();
    registry.registerCondition(ROUND_REACHED_KEY, roundReached);

    const template = authorTemplate("Victory Won (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 10,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .winWhen(ROUND_REACHED_KEY, { text: "You win." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    if (campaign.round !== 0) throw new Error(`expected round 0, got ${campaign.round}`);
    if (campaign.maxRounds !== 10) throw new Error(`expected maxRounds 10, got ${campaign.maxRounds}`);

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-won.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    // 2 players → 2 nextPlayer per round; 4 total reach round 2.
    const commands: Command[] = [
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 1 (ongoing)
      { kind: "nextPlayer" }, { kind: "nextPlayer" }, // → round 2 (won)
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

    // Coverage: the final step must carry a resolution cue with outcome "won".
    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "won")
      throw new Error(`expected outcome "won", got "${res.outcome}"`);
    if (campaign.outcome !== "won") throw new Error(`expected campaign.outcome "won", got "${campaign.outcome}"`);

    writeFileSync(join(here, "victory-won.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-won.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
