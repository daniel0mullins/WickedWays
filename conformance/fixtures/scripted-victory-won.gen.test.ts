/**
 * scripted-victory-won golden generator.
 *
 * TS side: the REAL Hollow House `reached-attic-with-journal` closure (via the
 * shared shadow) is the oracle. Rust side: the same key resolves to the scripted
 * `VictoryScript` in catalog.behaviors, evaluated through the World-backed room
 * resolver (party[0].room.name === "Attic"). Green = the AST + interpreter
 * reproduce the win closure — crucially the lazy `currentRoom.name` read.
 *
 * Ada grabs the journal in the Foyer, climbs Foyer → Hall → Attic; the win fires
 * the round she reaches the Attic holding the journal.
 *
 * Writes scripted-victory-won.{start.snapshot,catalog,golden}.json.
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
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { ITEM_FACTORIES } from "../../packages/campaigns/src/hollow-house/items.ts";
import { Conditions, Items, Rooms } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";
import { reachedAtticWithJournal } from "./hollow-victory-shadow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x51c1;

type Command =
  | { kind: "startTurn" } | { kind: "endTurn" } | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
  | { kind: "take"; targetId: string };

describe("generate scripted-victory-won golden", () => {
  it("writes the booted snapshot + per-step golden (won by reaching the Attic with the journal)", () => {
    const registry = defineRegistry({
      items: { [Items.Journal]: ITEM_FACTORIES[Items.Journal]! },
    });
    registry.registerCondition(Conditions.ReachedAtticWithJournal, reachedAtticWithJournal);

    const template = authorTemplate("Scripted Victory Won (conformance)", registry, {
      rng: mulberry32(SEED), maxRounds: 10, baseEncounterChance: 0,
    })
      .archetype({ id: "heir", name: "Heir",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 16, [StatType.Energy]: 5 } })
      .room(Rooms.Foyer, { description: "The entrance hall." })
      .room("Hall", { description: "A long central hall." })
      .room(Rooms.Attic, { description: "The attic, under the bare ribs of the roof." })
      .startRoom(Rooms.Foyer)
      .exit(Rooms.Foyer, Directions.North, "Hall").exit("Hall", Directions.South, Rooms.Foyer)
      .exit("Hall", Directions.North, Rooms.Attic).exit(Rooms.Attic, Directions.South, "Hall")
      .loot("foyer-table", { room: Rooms.Foyer, items: [Items.Journal], description: "A hall table." })
      .winWhen(Conditions.ReachedAtticWithJournal, { text: "You climb into the attic with the journal in hand, and at last the house is only a house. You understand. You may leave." });

    const campaign = startSession(template, {
      players: [{ name: "Ada", archetype: "heir" }],
      gm: 0,
    });

    const foyer = campaign.activeCharacter.currentRoom!;
    const table = [...foyer.loot.values()][0]!;
    const journalId = table.contents.find((i) => i.behaviorKey === Items.Journal)!.id as unknown as string;

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "scripted-victory-won.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      // R0 Ada: grab the journal, climb into the Hall; nextPlayer → round 1
      // (still in the Hall, not the Attic → ongoing).
      { kind: "startTurn" },
      { kind: "take", targetId: journalId },
      { kind: "go", dir: Directions.North },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R1 Ada: climb into the Attic holding the journal; nextPlayer → round 2 → WON.
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
    ];

    const pcNow = () => campaign.activeCharacter;
    const opened = new Set<string>();
    const findInLoot = (id: string): { loot: ILoot; item: IItem } => {
      const room = pcNow().currentRoom!;
      for (const loot of room.loot.values()) {
        const item = loot.contents.find((i) => (i.id as unknown as string) === id);
        if (item) return { loot, item };
      }
      throw new Error(`Item ${id} not found in any co-located loot container.`);
    };

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn": pcNow().startTurn(); break;
        case "endTurn": pcNow().endTurn(); break;
        case "nextPlayer": campaign.nextPlayer(); break;
        case "go": pcNow().go(cmd.dir); break;
        case "take": {
          const { loot, item } = findInLoot(cmd.targetId);
          if (!opened.has(loot.id as unknown as string)) {
            pcNow().openLootBox(loot);
            opened.add(loot.id as unknown as string);
          }
          pcNow().takeFromLootBox(loot, [item]);
          break;
        }
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, {}, opened),
      };
    });

    // ── self-checks: the final step wins with the real HH narration ──────────
    const last = steps[steps.length - 1]!;
    const res = last.cues.find((c) => c.kind === "resolution");
    if (!res) throw new Error(`expected a resolution cue on the final step, got ${JSON.stringify(last.cues)}`);
    if (res.kind === "resolution" && res.outcome !== "won")
      throw new Error(`expected outcome "won", got "${res.outcome}"`);
    if (res.kind === "resolution" &&
      res.narration?.text !== "You climb into the attic with the journal in hand, and at last the house is only a house. You understand. You may leave.")
      throw new Error(`expected the win narration, got ${JSON.stringify(res.narration)}`);
    if (campaign.outcome !== "won") throw new Error(`expected campaign.outcome "won", got "${campaign.outcome}"`);

    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      { [Items.Journal]: ITEM_FACTORIES[Items.Journal]! },
      [Items.Journal],
      {},
      { [Conditions.ReachedAtticWithJournal]: behaviors[Conditions.ReachedAtticWithJournal]! },
    );
    writeFileSync(join(here, "scripted-victory-won.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(here, "scripted-victory-won.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
