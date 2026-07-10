/**
 * rat-tail onUse golden generator — the item-onUse companion to the descriptor
 * spawn fixture. Mirrors `laudanum-use.gen.test.ts`.
 *
 * TS side: the REAL Hollow House `ratTail` factory closure (items.ts) — the
 * oracle. Its `use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); }`
 * heals +1 Sanity (descriptor stat: Sanity, modifier: 1), then the engine
 * consumes the usable item. Rust side: the `Items.RatTail` key resolves to
 * `ratTailScript` (an `onUse` emitting `adjust(actor, sanity, +1)`) carried in
 * `catalog.behaviors`. Green = the scripted `onUse` reproduces the real closure
 * byte-for-byte, including consumption.
 *
 * Base Sanity is 4 (< max), so `use` drives 4 → 5 (+1, uncapped up). One lit
 * room + a cabinet holding the rat-tail.
 *
 * Writes rat-tail.{start.snapshot,catalog,golden}.json.
 * Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { ratTail } from "../../packages/campaigns/src/hollow-house/items.ts";
import { Items } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x2a17;

type Command =
  | { kind: "startTurn" }
  | { kind: "take"; targetId: string }
  | { kind: "use"; targetId: string };

describe("generate rat-tail-use golden", () => {
  it("writes the booted snapshot + per-step golden (real HH ratTail oracle)", () => {
    // Register the REAL Hollow House ratTail factory (dogfooding — not a stub).
    const registry = defineRegistry({
      items: { [Items.RatTail]: ratTail },
    });

    // Base Sanity 4 so `use` drives 4 → 5 (+1, uncapped up). rng/now fixed for
    // determinism; maxRounds headroom. One lit room + a cabinet holding the tail.
    const template = authorTemplate("Rat-Tail Use (conformance)", registry, {
      rng: () => 0.5,
      now: () => 0,
      maxRounds: 10,
      baseEncounterChance: 0,
    })
      .archetype({
        id: "delver",
        name: "Delver",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 4 },
        inventorySlots: 5,
      })
      .room("Warren", { description: "A rat-gnawed cellar corner." })
      .startRoom("Warren")
      .loot("nest", {
        room: "Warren",
        items: [Items.RatTail],
        description: "A filthy nest of rags.",
      });

    const campaign = startSession(template, {
      players: [{ name: "Mara", archetype: "delver" }],
      gm: 0,
    });

    // Resolve the live rat-tail id from the nest.
    const warren = campaign.activeCharacter.currentRoom!;
    const nest = [...warren.loot.values()][0]!;
    const ratTailId = nest.contents.find((i) => i.behaviorKey === Items.RatTail)!.id as unknown as string;
    if (!ratTailId) throw new Error("Failed to resolve rat-tail id from the nest.");

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "rat-tail.start.snapshot.json"), JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // All budgeted actions after a startTurn (budget 3 covers take + use).
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "take", targetId: ratTailId },
      { kind: "use", targetId: ratTailId },
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
        case "startTurn":
          pcNow().startTurn();
          break;
        case "take": {
          const { loot, item } = findInLoot(cmd.targetId);
          if (!opened.has(loot.id as unknown as string)) {
            pcNow().openLootBox(loot);
            opened.add(loot.id as unknown as string);
          }
          pcNow().takeFromLootBox(loot, [item]);
          break;
        }
        case "use":
          // Runs the REAL ratTail closure (the oracle) → +1 Sanity, then consume.
          findHeld(cmd.targetId).actions.use(pcNow());
          break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, {}, opened),
      };
    });

    // ── self-checks: the fixture must actually exercise +1 Sanity + consumption ──
    const useIdx = commands.findIndex((c) => c.kind === "use");
    if (useIdx <= 0) throw new Error("Golden has no `use` step preceded by a capture step.");
    const before = (steps[useIdx - 1]!.view.status as { sanity: number }).sanity;
    const after = (steps[useIdx]!.view.status as { sanity: number }).sanity;
    if (after - before !== 1) throw new Error(`expected Sanity +1 on use, got ${before} -> ${after}`);
    if (after !== 5) throw new Error(`expected post-use Sanity 5 (base 4 + 1), got ${after}`);
    const finalStep = steps[steps.length - 1]!;
    const stillHeld = (finalStep.view.inventory.items as Array<{ name?: unknown }>).some(
      (i) => i.name === "Rat Tail",
    );
    if (stillHeld) throw new Error("Used rat-tail is still in inventory (should be consumed).");

    // Catalog: behaviors carries ratTailScript under the RatTail key so the Rust
    // side resolves `use` → the scripted `onUse`.
    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog({ [Items.RatTail]: ratTail }, [Items.RatTail], {}, behaviors);
    if (!catalog.behaviors[Items.RatTail]) throw new Error("Catalog behaviors is missing the rat-tail onUse script.");
    writeFileSync(join(here, "rat-tail.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(
      join(here, "rat-tail.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    console.log(`[rat-tail] id=${ratTailId}; Sanity ${before} -> ${after} (+1); consumed=${!stillHeld}`);
  });
});
