/**
 * laudanum-use golden generator.
 *
 * TS side: the REAL Hollow House `laudanum` factory closure (items.ts:44) — the
 * oracle. Its `use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); }`
 * heals +6 Sanity (descriptor stat: Sanity, modifier: 6). Rust side: the
 * `Items.Laudanum` key resolves to `laudanumScript` (an `onUse` emitting
 * `adjust(actor, sanity, +6)`) carried in `catalog.behaviors`.
 *
 * Coverage (spec gate target): the UNCAPPED-UP `AdjustStat` direction. The
 * PC's base Sanity is 4, so `use` drives 4 -> 10 (+6) — a direction dread's
 * -1 fixture never exercises. Green = the scripted `onUse` reproduces the real
 * `use` closure byte-for-byte for a large positive stat adjustment.
 *
 * Writes laudanum-use.{start.snapshot,catalog,golden}.json.
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
import { laudanum } from "../../packages/campaigns/src/hollow-house/items.ts";
import { Items } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x1a0d;

type Command =
  | { kind: "startTurn" }
  | { kind: "take"; targetId: string }
  | { kind: "use"; targetId: string };

describe("generate laudanum-use golden", () => {
  it("writes the booted snapshot + per-step golden (real HH laudanum oracle)", () => {
    // Register the REAL Hollow House laudanum factory (dogfooding — not a stub).
    const registry = defineRegistry({
      items: { [Items.Laudanum]: laudanum },
    });

    // Base Sanity 4 so `use` drives 4 -> 10 (+6, uncapped up). rng/now fixed for
    // determinism; maxRounds headroom. One lit room + a cabinet holding the vial.
    const template = authorTemplate("Laudanum Use (conformance)", registry, {
      rng: () => 0.5,
      now: () => 0,
      maxRounds: 10,
      baseEncounterChance: 0,
    })
      .archetype({
        id: "patient",
        name: "Patient",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 4 },
        inventorySlots: 5,
      })
      .room("Ward", { description: "A dim recovery ward." })
      .startRoom("Ward")
      .loot("cabinet", {
        room: "Ward",
        items: [Items.Laudanum],
        description: "A medicine cabinet.",
      });

    const campaign = startSession(template, {
      players: [{ name: "Mara", archetype: "patient" }],
      gm: 0,
    });

    // Resolve the live laudanum id from the ward cabinet.
    const ward = campaign.activeCharacter.currentRoom!;
    const cabinet = [...ward.loot.values()][0]!;
    const laudanumId = cabinet.contents.find(
      (i) => i.behaviorKey === Items.Laudanum,
    )!.id as unknown as string;
    if (!laudanumId) throw new Error("Failed to resolve laudanum id from the ward cabinet.");

    const start = serializeCampaign(campaign);
    writeFileSync(
      join(here, "laudanum-use.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );

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
      { kind: "take", targetId: laudanumId },
      { kind: "use", targetId: laudanumId },
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
          // Runs the REAL laudanum closure (the oracle) → +6 Sanity, then consume.
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

    // ── self-checks: the fixture must actually exercise +6 Sanity + consumption ──
    const useIdx = commands.findIndex((c) => c.kind === "use");
    if (useIdx <= 0) throw new Error("Golden has no `use` step preceded by a capture step.");
    const preUse = steps[useIdx - 1]!;
    const atUse = steps[useIdx]!;
    const before = (preUse.view.status as { sanity: number }).sanity;
    const after = (atUse.view.status as { sanity: number }).sanity;
    if (after - before !== 6) {
      throw new Error(`expected Sanity +6 on use (uncapped up), got ${before} -> ${after}`);
    }
    if (after !== 10) {
      throw new Error(`expected post-use Sanity 10 (base 4 + 6), got ${after}`);
    }
    // The used consumable is gone: the final step's inventory must not hold the vial.
    const finalStep = steps[steps.length - 1]!;
    const stillHeld = (finalStep.view.inventory.items as Array<{ name?: unknown }>).some(
      (i) => i.name === "Vial of Laudanum",
    );
    if (stillHeld) throw new Error("Used Laudanum is still in inventory (should be consumed).");

    // Catalog: behaviors carries laudanumScript under the Laudanum key so the
    // Rust side resolves `use` → the scripted `onUse`.
    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      { [Items.Laudanum]: laudanum },
      [Items.Laudanum],
      {},
      behaviors,
    );
    if (!catalog.behaviors[Items.Laudanum]) {
      throw new Error("Catalog behaviors is missing the laudanum onUse script.");
    }
    writeFileSync(
      join(here, "laudanum-use.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "laudanum-use.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    console.log(
      `[laudanum-use] laudanum id=${laudanumId}; Sanity ${before} -> ${after} (+6); consumed=${!stillHeld}`,
    );
  });
});
