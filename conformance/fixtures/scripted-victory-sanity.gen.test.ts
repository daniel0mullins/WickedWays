/**
 * scripted-victory-sanity golden generator.
 *
 * TS side: the REAL Hollow House `sanity-zero` closure (via the shared shadow) is
 * the oracle. Rust side: the same key resolves to the scripted `VictoryScript`
 * (`some(party, sanity <= 0)`). The REAL `dread` mechanic drains Ada's sanity
 * from 1 → 0 on her first turn; the round resolves LOST.
 *
 * `dread` is live in the snapshot, so it must ALSO resolve on the Rust side —
 * hence it is carried in catalog.behaviors alongside the victory script.
 *
 * Writes scripted-victory-sanity.{start.snapshot,catalog,golden}.json.
 * Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import type { PresentationCue } from "wickedways/lib/presentation";
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { dread } from "../../packages/campaigns/src/hollow-house/mechanics.ts";
import { Conditions, Mechanics, Rooms } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";
import { sanityZero } from "./hollow-victory-shadow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x51c2;

type Command = { kind: "startTurn" } | { kind: "endTurn" } | { kind: "nextPlayer" };

describe("generate scripted-victory-sanity golden", () => {
  it("writes the booted snapshot + per-step golden (lost when dread drains sanity to 0)", () => {
    const registry = defineRegistry({
      items: {},
      mechanics: { [Mechanics.Dread]: dread },
    });
    registry.registerCondition(Conditions.SanityZero, sanityZero);

    const template = authorTemplate("Scripted Victory Sanity (conformance)", registry, {
      rng: mulberry32(SEED), maxRounds: 10, baseEncounterChance: 0,
    })
      .archetype({ id: "heir", name: "Heir",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 1, [StatType.Energy]: 5 } })
      .room(Rooms.Foyer, { description: "The entrance hall." })
      .startRoom(Rooms.Foyer)
      .useMechanic(Mechanics.Dread)
      .loseWhen(Conditions.SanityZero, { text: "The dark gets in. Your thoughts come apart like wet paper, and the Hollow House keeps what is left of you." });

    const campaign = startSession(template, {
      players: [{ name: "Ada", archetype: "heir" }],
      gm: 0,
    });

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "scripted-victory-sanity.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      { kind: "startTurn" }, // dread drains sanity 1 → 0
      { kind: "endTurn" },
      { kind: "nextPlayer" }, // round end → LOST via some(sanity <= 0)
    ];

    const pcNow = () => campaign.activeCharacter;
    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn": pcNow().startTurn(); break;
        case "endTurn": pcNow().endTurn(); break;
        case "nextPlayer": campaign.nextPlayer(); break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign),
      };
    });

    // ── self-checks ──────────────────────────────────────────────────────────
    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "lost")
      throw new Error(`expected outcome "lost", got "${res.outcome}"`);
    if (res.kind === "resolution" &&
      res.narration?.text !== "The dark gets in. Your thoughts come apart like wet paper, and the Hollow House keeps what is left of you.")
      throw new Error(`expected the lose narration, got ${JSON.stringify(res.narration)}`);
    if (campaign.outcome !== "lost") throw new Error(`expected campaign.outcome "lost", got "${campaign.outcome}"`);

    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      {},
      [],
      {},
      {
        [Mechanics.Dread]: behaviors[Mechanics.Dread]!,
        [Conditions.SanityZero]: behaviors[Conditions.SanityZero]!,
      },
    );
    writeFileSync(join(here, "scripted-victory-sanity.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(here, "scripted-victory-sanity.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
