/**
 * victory-ended golden generator — run once to write the committed fixtures.
 *
 * Two-player campaign with an .onEnd fallback narration. A single `endCampaign`
 * command at round 0 → manual "ended" outcome with the ended narration on the
 * cue. Exercises Command::EndCampaign on the Rust replay side.
 *
 * Writes victory-ended.{start.snapshot,catalog,golden}.json.
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
const SEED = 0xe4de;
const EMPTY_CATALOG = { items: {}, aliases: {} };

type Command = { kind: "endCampaign" };

describe("generate victory-ended golden", () => {
  it("writes the booted snapshot + per-step golden (manual ended)", () => {
    const registry = buildSeedRegistry();

    const template = authorTemplate("Victory Ended (conformance)", registry, {
      rng: mulberry32(SEED),
      maxRounds: 10,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Start", { description: "the entrance" })
      .startRoom("Start")
      .onEnd({ text: "You leave." });

    const campaign = startSession(template, {
      players: [
        { name: "Ada", archetype: "delver" },
        { name: "Ben", archetype: "delver" },
      ],
      gm: 0,
    });

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "victory-ended.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [{ kind: "endCampaign" }];
    const steps = commands.map((cmd) => {
      campaign.endCampaign();
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "ended")
      throw new Error(`expected outcome "ended", got "${res.outcome}"`);
    if (res.kind === "resolution" && res.narration?.text !== "You leave.")
      throw new Error(`expected ended narration, got ${JSON.stringify(res.narration)}`);

    writeFileSync(join(here, "victory-ended.catalog.json"), JSON.stringify(EMPTY_CATALOG, null, 2) + "\n");
    writeFileSync(join(here, "victory-ended.golden.json"), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
