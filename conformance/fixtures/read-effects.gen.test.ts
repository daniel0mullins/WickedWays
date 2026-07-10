/**
 * read-effects golden generator — scripted `onRead` differential fixture.
 *
 * SYNTHETIC ORACLE RATIONALE: no first-party Hollow House item carries a
 * non-noop `read` closure — every HH item's `read` is inert lore only. So this
 * fixture uses a SYNTHETIC "Cursed Note": a Consumable with an authored `read`
 * action closure that DRAINS 2 Sanity, plus `lore: "The ink writhes."`. This is
 * the same synthetic-item approach `items-actions.gen.test.ts` uses (bespoke
 * factories authored inline, not dogfooded HH content).
 *
 * TS side (the oracle): `Character.read` runs the `read` action closure
 * (`holder[ADJUST_STAT](StatType.Sanity, -2)`) FIRST, THEN emits the lore cue
 * (src/lib/character/character.ts:784-792). Rust side: the NOTE_KEY resolves to
 * a scripted `item({ onRead: [emit(adjust(actor, sanity, -2))] })` in
 * `catalog.behaviors`; `read_item` applies the onRead effect BEFORE pushing the
 * lore cue (crates/.../world/submit.rs:344-379).
 *
 * The whole point of the gate: the read step's captured `view` shows Sanity
 * already dropped by 2 AND the same step's `cues` carry the lore mechanic cue —
 * proving the effect is ordered before the lore cue in BOTH engines.
 *
 * Writes read-effects.{start.snapshot,catalog,golden}.json.
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
import { Item, ItemType } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { ADJUST_STAT } from "wickedways/lib/mechanics/symbols";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { item, emit, adjust, actor, lit } from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x4e07;

const NOTE_KEY = "items/cursed-note";
const NOTE_LORE = "The ink writhes.";

const ALIASES: Record<string, string[]> = {
  [NOTE_KEY]: ["note", "cursed note"],
};

const noop = () => {};

/**
 * The synthetic Cursed Note: Consumable, NOT usable, carries lore, and an
 * authored `read` closure that drains 2 Sanity. `Item`'s `actions` type accepts
 * an optional `read` entry (ItemAction.Read, src/lib/inventory.ts:105); the
 * other keys are required, so we noop them (mirrors items-actions.gen.test.ts).
 */
function makeCursedNote(): Item {
  return new Item({
    descriptor: {
      behaviorKey: NOTE_KEY,
      name: "Cursed Note",
      type: ItemType.Consumable,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      lore: NOTE_LORE,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
    actions: {
      pickUp: noop,
      equip: noop,
      unequip: noop,
      transfer: noop,
      use: noop,
      read: (holder) => holder[ADJUST_STAT](StatType.Sanity, -2),
      destroy: () => null,
    },
    events: { onPickUp: noop },
  });
}

type Command =
  | { kind: "startTurn" }
  | { kind: "take"; targetId: string }
  | { kind: "read"; targetId: string };

describe("generate read-effects golden", () => {
  it("writes the booted snapshot + per-step golden (synthetic onRead oracle)", () => {
    const registry = defineRegistry({
      items: { [NOTE_KEY]: makeCursedNote },
    });

    // Archetype base Sanity 7 so `read` drives 7 -> 5 (-2). One lit room with a
    // chest holding the note. rng/now fixed for determinism; maxRounds headroom.
    const template = authorTemplate("Read Effects (conformance)", registry, {
      rng: () => 0.5,
      now: () => 0,
      maxRounds: 10,
      baseEncounterChance: 0,
    })
      .archetype({
        id: "reader",
        name: "Reader",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 7 },
        inventorySlots: 5,
      })
      .room("Study", { description: "A candle-lit study." })
      .startRoom("Study")
      .loot("chest", {
        room: "Study",
        items: [NOTE_KEY],
        description: "An old writing chest.",
      });

    const campaign = startSession(template, {
      players: [{ name: "Ida", archetype: "reader" }],
      gm: 0,
    });

    // Resolve the live note id from the study chest.
    const study = campaign.activeCharacter.currentRoom!;
    const chest = [...study.loot.values()][0]!;
    const noteId = chest.contents.find(
      (i) => i.behaviorKey === NOTE_KEY,
    )!.id as unknown as string;
    if (!noteId) throw new Error("Failed to resolve the cursed note id from the study chest.");

    const start = serializeCampaign(campaign);
    writeFileSync(
      join(here, "read-effects.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // Budget 3 covers take + read (read is free/ungated regardless).
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "take", targetId: noteId },
      { kind: "read", targetId: noteId },
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
        const found = loot.contents.find((i) => (i.id as unknown as string) === id);
        if (found) return { loot, item: found };
      }
      throw new Error(`Item ${id} not found in any co-located loot container.`);
    };

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "take": {
          const { loot, item: found } = findInLoot(cmd.targetId);
          if (!opened.has(loot.id as unknown as string)) {
            pcNow().openLootBox(loot);
            opened.add(loot.id as unknown as string);
          }
          pcNow().takeFromLootBox(loot, [found]);
          break;
        }
        case "read":
          // Runs the synthetic read closure (the oracle) → -2 Sanity, THEN emits
          // the lore cue via Character.read (character.ts:788-790).
          pcNow().read(findHeld(cmd.targetId));
          break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, ALIASES, opened),
      };
    });

    // ── self-checks: -2 Sanity applied AND ordered before the lore cue ──────────
    const readIdx = commands.findIndex((c) => c.kind === "read");
    if (readIdx <= 0) throw new Error("Golden has no `read` step preceded by a capture step.");
    const preRead = steps[readIdx - 1]!;
    const atRead = steps[readIdx]!;
    const before = (preRead.view.status as { sanity: number }).sanity;
    const after = (atRead.view.status as { sanity: number }).sanity;
    if (before - after !== 2) {
      throw new Error(`expected Sanity -2 on read, got ${before} -> ${after}`);
    }
    if (after !== 5) {
      throw new Error(`expected post-read Sanity 5 (base 7 - 2), got ${after}`);
    }
    // The read step's cues must carry the lore mechanic cue — proving the effect
    // (already reflected in `after`) is ordered before the lore cue in one step.
    const loreHit = atRead.cues.some(
      (c) => c.kind === "mechanic" && c.cue.text === NOTE_LORE,
    );
    if (!loreHit) {
      throw new Error(`expected the read step's cues to include the lore "${NOTE_LORE}".`);
    }
    // The note is a non-consuming read: it must still be held after reading.
    const stillHeld = (atRead.view.inventory.items as Array<{ name?: unknown }>).some(
      (i) => i.name === "Cursed Note",
    );
    if (!stillHeld) throw new Error("Read Cursed Note is missing (read must NOT consume it).");

    // Catalog: behaviors carries the scripted onRead under NOTE_KEY so the Rust
    // side resolves `read` → the scripted `onRead` effect.
    const behaviors = {
      [NOTE_KEY]: item({ onRead: [emit(adjust(actor, StatType.Sanity, lit(-2)))] }),
    };
    const catalog = buildCatalog(
      { [NOTE_KEY]: makeCursedNote },
      [NOTE_KEY],
      ALIASES,
      behaviors,
    );
    if (!catalog.behaviors[NOTE_KEY]) {
      throw new Error("Catalog behaviors is missing the cursed-note onRead script.");
    }
    writeFileSync(
      join(here, "read-effects.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "read-effects.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    console.log(
      `[read-effects] note id=${noteId}; Sanity ${before} -> ${after} (-2); lore cue on read step=${loreHit}`,
    );
  });
});
