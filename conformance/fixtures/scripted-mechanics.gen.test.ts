/**
 * scripted-mechanics golden generator.
 *
 * TS side: the REAL Hollow House closures (dread / makeStoryteller(LORE) /
 * statusBar) — the oracle. Rust side: the same keys resolve to the scripted
 * ASTs carried in catalog.behaviors. Green = the AST + interpreter reproduce
 * the closures byte-for-byte (incl. num->string Status fields and the
 * action.room.name storyteller read).
 *
 * Coverage (spec gate list):
 *   dread        — drain without the lantern; NO drain once it is equipped
 *   storyteller  — lore cue on first journal-carrying entry to the Parlor;
 *                  dedupe on re-entry; no cue without the journal (Ben);
 *                  no cue in a non-lore room (Foyer)
 *   status-bar   — Sanity emphasis normal (7) / warn (6..4) / critical (<=3)
 *                  + the "round/maxRounds" concat, per turn-end and round-start
 *
 * Writes scripted-mechanics.{start.snapshot,catalog,golden}.json.
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
import { Status } from "wickedways/lib/status";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { dread, makeStoryteller } from "../../packages/campaigns/src/hollow-house/mechanics.ts";
import { statusBar } from "../../packages/campaigns/src/hollow-house/status.ts";
import { LORE } from "../../packages/campaigns/src/hollow-house/content.ts";
import { ITEM_FACTORIES } from "../../packages/campaigns/src/hollow-house/items.ts";
import { Items, Mechanics, Rooms } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x5c21;

type Command =
  | { kind: "startTurn" } | { kind: "endTurn" } | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
  | { kind: "take"; targetId: string }
  | { kind: "equip"; targetId: string };

describe("generate scripted-mechanics golden", () => {
  it("writes the booted snapshot + per-step golden", () => {
    const registry = defineRegistry({
      items: { [Items.Lantern]: ITEM_FACTORIES[Items.Lantern]!, [Items.Journal]: ITEM_FACTORIES[Items.Journal]! },
      mechanics: {
        [Mechanics.Dread]: dread,
        [Mechanics.Storyteller]: makeStoryteller(LORE),
        [Mechanics.StatusBar]: statusBar,
      },
    });

    const template = authorTemplate("Scripted Mechanics (conformance)", registry, {
      rng: mulberry32(SEED), maxRounds: 10, baseEncounterChance: 0,
    })
      // Ada (heir): sanity 8 -> normal(7)/warn(6). Ben (frail): sanity 6, drains
      // 6->5->4->3 across the three rounds -> warn(5,4) then critical(3). Ben is
      // immune to the three CLEARABLE afflictions so he can always move (the
      // no-journal Parlor entry) and, crucially, no per-turn shake-off ROLL fires
      // — keeping this stream free of any affliction RNG so both engines agree.
      .archetype({ id: "heir", name: "Heir",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 8, [StatType.Energy]: 5 } })
      .archetype({ id: "frail", name: "Frail",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 6, [StatType.Energy]: 5 },
        immunities: [Status.Fear, Status.Panic, Status.Confused] })
      .room(Rooms.Foyer, { description: "The entrance hall." })
      .room(Rooms.Parlor, { description: "A mildewed parlor." }) // a LORE room
      .startRoom(Rooms.Foyer)
      .exit(Rooms.Foyer, Directions.East, Rooms.Parlor)
      .exit(Rooms.Parlor, Directions.West, Rooms.Foyer)
      .loot("foyer-table", { room: Rooms.Foyer, items: [Items.Journal, Items.Lantern],
        description: "A hall table." })
      .useMechanic(Mechanics.Dread)
      .useMechanic(Mechanics.Storyteller)
      .useMechanic(Mechanics.StatusBar);

    const campaign = startSession(template, {
      players: [{ name: "Ada", archetype: "heir" }, { name: "Ben", archetype: "frail" }],
      gm: 0,
    });

    // Resolve the loot item ids for the command stream.
    const foyer = campaign.activeCharacter.currentRoom!;
    const table = [...foyer.loot.values()][0]!;
    const journalId = table.contents.find((i) => i.behaviorKey === Items.Journal)!.id as unknown as string;
    const lanternId = table.contents.find((i) => i.behaviorKey === Items.Lantern)!.id as unknown as string;

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "scripted-mechanics.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      // R0 Ada (sanity 8 -> 7 at startTurn): grab both loot items (2 budget of 3);
      // endTurn -> onTurnEnd status paints Sanity 7 -> "normal".
      { kind: "startTurn" },
      { kind: "take", targetId: journalId },
      { kind: "take", targetId: lanternId },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R0 Ben (6 -> 5): moves into the Parlor WITHOUT the journal -> no lore cue
      // (post-drain sanity 5 >= 5, so no Fear block); endTurn -> Sanity 5 "warn".
      { kind: "startTurn" },
      { kind: "go", dir: Directions.East },
      { kind: "endTurn" },
      { kind: "nextPlayer" }, // round end -> round 1 -> statusBar round-start paint (Ada 7 "normal")
      // R1 Ada (7 -> 6): equip lantern (free), first journal-carrying Parlor entry -> LORE cue,
      // back to the Foyer (non-lore -> no cue); endTurn -> Sanity 6 "warn".
      { kind: "startTurn" },
      { kind: "equip", targetId: lanternId },
      { kind: "go", dir: Directions.East },
      { kind: "go", dir: Directions.West },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R1 Ben (5 -> 4): immune to Fear, but simply sits this round; endTurn -> Sanity 4 "warn".
      { kind: "startTurn" },
      { kind: "endTurn" },
      { kind: "nextPlayer" }, // -> round 2 (paint Ada 6 "warn")
      // R2 Ada: lantern equipped -> NO drain (stays 6); Parlor re-entry -> dedupe, no cue;
      // back to the Foyer; endTurn -> Sanity 6 "warn".
      { kind: "startTurn" },
      { kind: "go", dir: Directions.East },
      { kind: "go", dir: Directions.West },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R2 Ben (4 -> 3): endTurn -> Sanity 3 "critical".
      { kind: "startTurn" },
      { kind: "endTurn" },
      { kind: "nextPlayer" }, // -> round 3 (paint Ada 6 "warn")
    ];

    const pcNow = () => campaign.activeCharacter;
    const findHeld = (id: string): IItem => {
      const it = pcNow().inventory.items.find((i) => (i.id as unknown as string) === id);
      if (!it) throw new Error(`Item ${id} not held by active PC.`);
      return it;
    };
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
        case "equip": pcNow().equip(findHeld(cmd.targetId)); break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, {}, opened),
      };
    });

    // ── self-checks: the fixture must actually exercise the gate coverage ────
    const allCues = steps.flatMap((s) => s.cues);
    const mechanicTexts = allCues
      .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
      .map((c) => c.cue.text);
    const loreHits = mechanicTexts.filter((t) => t === LORE[Rooms.Parlor]);
    if (loreHits.length !== 1) throw new Error(`expected exactly 1 Parlor lore cue, got ${loreHits.length}`);
    const emphases = new Set(
      allCues
        .filter((c): c is Extract<PresentationCue, { kind: "status" }> => c.kind === "status")
        .flatMap((c) => c.fields.filter((f) => f.label === "Sanity").map((f) => f.emphasis)),
    );
    for (const want of ["normal", "warn", "critical"]) {
      if (!emphases.has(want as never)) throw new Error(`missing Sanity emphasis "${want}"`);
    }
    // the lantern blocked round-2 drain: Ada's sanity is unchanged at 6
    const ada = campaign.party[0]!;
    if (ada.effectiveStat(StatType.Sanity) !== 6) {
      throw new Error(`expected Ada sanity 6 after the shielded turn, got ${ada.effectiveStat(StatType.Sanity)}`);
    }

    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      { [Items.Lantern]: ITEM_FACTORIES[Items.Lantern]!, [Items.Journal]: ITEM_FACTORIES[Items.Journal]! },
      [Items.Lantern, Items.Journal],
      {},
      {
        [Mechanics.Dread]: behaviors[Mechanics.Dread]!,
        [Mechanics.Storyteller]: behaviors[Mechanics.Storyteller]!,
        [Mechanics.StatusBar]: behaviors[Mechanics.StatusBar]!,
      },
    );
    writeFileSync(join(here, "scripted-mechanics.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(here, "scripted-mechanics.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
