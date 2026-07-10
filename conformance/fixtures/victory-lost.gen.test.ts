/**
 * victory-lost golden generator — run once to write the committed fixture files.
 *
 * Same as victory-won but the SAME key `conformance:round-reached` is placed in
 * BOTH the win list (.winWhen) and the lose list (.loseWhen), with distinct
 * per-list narration. At round 2 both fire; resolveOutcome checks the loss list
 * first → outcome "lost" with the LOSE narration. Proves lose-before-win.
 *
 * Writes victory-lost.{start.snapshot,catalog,golden}.json.
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
const SEED = 0x105e;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "nextPlayer" };

describe("generate victory-lost golden", () => {
  it("writes the booted snapshot + per-step golden (lost via precedence)", () => {
    const registry = buildSeedRegistry();
    registry.registerCondition(ROUND_REACHED_KEY, roundReached);

    const template = authorTemplate("Victory Lost (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 10,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .winWhen(ROUND_REACHED_KEY, { text: "win" })
      .loseWhen(ROUND_REACHED_KEY, { text: "lose" });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    if (campaign.round !== 0) throw new Error(`expected round 0, got ${campaign.round}`);

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-lost.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      { kind: "nextPlayer" }, { kind: "nextPlayer" },
      { kind: "nextPlayer" }, { kind: "nextPlayer" },
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
    if (res.kind === "resolution" && res.outcome !== "lost")
      throw new Error(`expected outcome "lost", got "${res.outcome}"`);
    if (res.kind === "resolution" && (res.narration?.text !== "lose"))
      throw new Error(`expected LOSE narration, got ${JSON.stringify(res.narration)}`);
    if (campaign.outcome !== "lost") throw new Error(`expected campaign.outcome "lost", got "${campaign.outcome}"`);

    writeFileSync(join(here, "victory-lost.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-lost.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
