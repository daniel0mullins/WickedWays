/**
 * Fractional-material-drop golden generator — run once to write the committed
 * fixture files.
 *
 * DIFFERENTIAL PROOF of the 6c-4 `deposit_materials` f64 fix: the defeated mob
 * is authored with a FRACTIONAL `materialDrops` entry (`ectoplasm: 2.5`). The
 * TS oracle deposits the fractional quantity into the campaign materials pool
 * verbatim; before the 6c-4 fix, the Rust engine truncated fractional deposit
 * quantities to integers and would deposit 0 — turning this fixture RED. After
 * the fix, Rust deposits 2.5 and the differential is GREEN.
 *
 * Structurally a close copy of `mob-defeat.gen.test.ts`: the player moves into
 * the mob's room (triggering encounter cues), attacks the pre-placed Ghoul to
 * KO (depositing the fractional materials + a `mob:Ghoul:remains` loot box
 * with a relic), then takes the relic from the remains box.
 *
 * Seeded RNG is CRITICAL: all affliction rolls draw from a SINGLE shared
 * `mulberry32(SEED)` instance — mirroring the Rust World's single `pub rng: Rng`
 * seeded once via `replay_commands(.., seed)`.
 *
 * The start snapshot is serialized AFTER items are equipped but BEFORE the first
 * command. No rng is drawn during equip (no afflictions at boot; no encounters;
 * baseEncounterChance 0 — no encounter FORMATION is registered either, so no
 * formation can offset the value-dependent combat rng stream).
 *
 * Writes:
 *   - material-drop.start.snapshot.json  (serialized genesis state, pre-command)
 *   - material-drop.catalog.json         ({ items, aliases } Rust Catalog shape)
 *   - material-drop.golden.json          ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum
 * (#[serde(tag="kind", rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "attack", "targetId": "<CharacterId>" }
 *   { "kind": "go",     "dir": "<Direction>" }
 *   { "kind": "take",   "targetId": "<ItemId>", "lootId": "<LootId>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { structuralClone, viewProjected } from "./gen-helpers.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import type { ItemId, MaterialMap } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

/** Dagger: weapon, Health+3, maxDurability 5 (never breaks in this short stream). */
const DAGGER_KEY = "items/dagger";

/** Bone Relic: accessory, Sanity+1, no durability — the Ghoul's drop item. */
const RELIC_KEY = "items/bone-relic";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [DAGGER_KEY]: ["dagger", "iron dagger"],
  [RELIC_KEY]: ["relic", "bone relic"],
};

// ─── Item factories ───────────────────────────────────────────────────────────

const noop = () => {};

/** Iron dagger: weapon targeting Health, maxDurability 5. */
function makeDagger(): Item {
  return new Item({
    descriptor: {
      behaviorKey: DAGGER_KEY,
      name: "Iron Dagger",
      type: ItemType.Weapon,
      recipe: { item: 1 },
      modifier: 3,
      stat: StatType.Health,
      maxDurability: 5,
      slot: SlotKind.Hand,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/** Bone relic: accessory targeting Sanity, no durability. */
function makeRelic(): Item {
  return new Item({
    descriptor: {
      behaviorKey: RELIC_KEY,
      name: "Bone Relic",
      type: ItemType.Accessory,
      recipe: { item: 1 },
      modifier: 1,
      stat: StatType.Sanity,
      slot: SlotKind.Finger,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildItemRegistry() {
  return defineRegistry({
    items: {
      [DAGGER_KEY]: makeDagger,
      [RELIC_KEY]: makeRelic,
    },
  });
}

// ─── Catalog exporter ─────────────────────────────────────────────────────────

function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    type: item.type,
    stat: item.stat,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    ...(item.slot !== undefined ? { slot: item.slot } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

function buildCatalog(
  registry: ReturnType<typeof buildItemRegistry>,
  itemKeys: string[],
  aliases: Record<string, string[]>,
): { items: Record<string, unknown>; aliases: Record<string, string[]> } {
  const items: Record<string, unknown> = {};
  for (const key of itemKeys) {
    const factory = registry.item(key);
    const instance = factory();
    items[key] = itemToCatalogEntry(instance);
  }
  return { items, aliases };
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────
//
// Hall (start, lit) → North → Crypt (lit, holds Ghoul).
// Player: Ada (health=10, sanity=10, energy=10). Equipped with an Iron Dagger.
// Ghoul (mob): stats health=4, sanity=4, energy=4.
//   materialDrops: { ectoplasm: 2.5 }  — FRACTIONAL qty deposited into the
//     campaign pool on KO. This is the 6c-4 f64 proof: pre-fix Rust truncated
//     the quantity and deposited 0.
//   drops: ["items/bone-relic"] — loaded into Ghoul's inventory, falls into remains.
//   origin: "room" (authored via mobs list with room: "Crypt") — room-origin.
//
// Damage per dagger attack (no armor on Ghoul):
//   attackStrength = 3 (dagger modifier)
//   armorSum = 0
//   mitigator = Ghoul's Sanity (Health mitigated by Sanity) = 4
//   damageMultiplier = max(0, 10 - 4) * 0.2 = 6 * 0.2 = 1.2
//   damage = 3 * 1.2 = 3.6 per hit
//
// Hit 1: health 4 - 3.6 = 0.4
// Hit 2: health 0.4 - 3.6 = -3.2 → KO at 0  ✓ (2 attacks)
//
// Command stream (all in 1 round, Ada has actionsPerRound=3):
//   startTurn → go(North) [budget 1] → attack [budget 2] → attack → KO [budget 3 → endTurn]
//   nextPlayer → startTurn → take(relic from remains) [budget 1 via addToInventory]
//
// No afflictions (healthy stats), baseEncounterChance=0 (no random spawns),
// and NO encounter formation registered — nothing can offset the rng stream.
// Single mulberry32(SEED) shared into PC + campaign rng.

function buildMaterialDropCampaign(rng: () => number) {
  const registry = buildItemRegistry();

  const template = authorTemplate("Material Drop (conformance)", registry, {
    rng,
    maxRounds: 20,
    baseEncounterChance: 0,
  })
    .archetype({
      id: "fighter",
      name: "Fighter",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10,
      },
    })
    .room("Hall", { description: "A stone hall." })
    .room("Crypt", { description: "A dark crypt." })
    .startRoom("Hall")
    .exit("Hall", Directions.North, "Crypt")
    .mob("Ghoul", {
      stats: {
        [StatType.Health]: 4,
        [StatType.Sanity]: 4,
        [StatType.Energy]: 4,
      },
      room: "Crypt",
      // "ectoplasm" is deliberately outside the closed ItemComponentType union:
      // the deposit path treats material keys as opaque strings at runtime (the
      // Rust side deserializes an open JSON map), and a bespoke key guarantees
      // the 2.5 in the pool can only have come from this drop.
      materialDrops: { ectoplasm: 2.5 } as unknown as MaterialMap,
      drops: [RELIC_KEY],
    });

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("fighter" as never);
  ada.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry, rooms, ada };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
  | { kind: "attack"; targetId: string }
  | { kind: "take"; targetId: string; lootId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate material-drop golden", () => {
  it("writes the material-drop snapshot, catalog, and golden", () => {
    // Brute-force search for the first seed 1..500 satisfying all coverage
    // assertions. No affliction gate rng is expected to fire (the PC is healthy
    // with max stats throughout), so SEED=1 should work. The loop is retained
    // for structural parity with the combat template.
    let SEED = -1;
    let goldenSeed = -1;
    let goldenStart: ReturnType<typeof serializeCampaign> | undefined;
    let goldenCatalog: ReturnType<typeof buildCatalog> | undefined;
    let goldenCommands: Command[] | undefined;
    let goldenSteps: Array<{
      command: Command;
      cues: PresentationCue[];
      snapshot: ReturnType<typeof serializeCampaign>;
      view: ReturnType<typeof viewProjected>;
    }> | undefined;

    for (let seed = 1; seed <= 500; seed++) {
      const rng = mulberry32(seed);
      const { campaign, registry, ada } = buildMaterialDropCampaign(rng);

      // ── Equip the dagger ───────────────────────────────────────────────────
      // Equipped during setup (no afflictions → gate allows; no rng drawn).
      const daggerItem = registry.item(DAGGER_KEY)();
      daggerItem.id = `player:Ada:item#${DAGGER_KEY}` as ItemId;
      ada.addToInventory(daggerItem);
      ada.equip(daggerItem, EquipmentSlot.LeftHand);

      // ── Genesis snapshot (pre-command, dagger equipped) ────────────────────
      const start = structuralClone(serializeCampaign(campaign));

      // ── Build catalog ──────────────────────────────────────────────────────
      const itemKeys = [DAGGER_KEY, RELIC_KEY];
      const catalog = buildCatalog(registry, itemKeys, ALIASES);

      // ── Cue capture ────────────────────────────────────────────────────────
      let buf: PresentationCue[] = [];
      campaign.onCue((c: PresentationCue) => buf.push(c));
      const drain = () => {
        const out = buf;
        buf = [];
        return out;
      };

      // ── `opened` set (tracks which loot boxes have been opened) ───────────
      const opened = new Set<string>();

      // ── Resolve Ghoul id for attack commands ──────────────────────────────
      // Mob authored via assembler's mobs list → id = "mob:Ghoul"
      const GHOUL_ID = "mob:Ghoul";
      // The remains box id = "mob:Ghoul:remains"
      const REMAINS_ID = "mob:Ghoul:remains";
      // The relic item id = "mob:Ghoul:drop#0"
      const RELIC_ITEM_ID = "mob:Ghoul:drop#0";

      // ── The command stream ─────────────────────────────────────────────────
      //
      // Round 0, Ada's turn:
      //   startTurn
      //   go(North)  → enters Crypt → NOTE_ENCOUNTERS fires encounter cue + mob codex
      //   attack(Ghoul) → hit 1 (health 4 → 0.4)
      //   attack(Ghoul) → hit 2 (health 0.4 → 0) KO → 2.5 ectoplasm deposited +
      //                   remains box dropped → endTurn (budget 3/3)
      //   nextPlayer → Ada again (single-player party), round 1
      //
      // Round 1, Ada's turn:
      //   startTurn
      //   take(relic from remains box) → relic moves to Ada's inventory
      //
      const commands: Command[] = [
        // Round 0, Ada's turn
        { kind: "startTurn" },
        { kind: "go", dir: Directions.North },   // Hall → Crypt; encounter fires
        { kind: "attack", targetId: GHOUL_ID },  // hit 1
        { kind: "attack", targetId: GHOUL_ID },  // hit 2 → KO → remains drop → endTurn
        { kind: "nextPlayer" },                   // round 1, Ada active
        // Round 1, Ada's turn
        { kind: "startTurn" },
        { kind: "take", targetId: RELIC_ITEM_ID, lootId: REMAINS_ID },
      ];

      // ── Drive the engine directly, capturing per-step state ─────────────────
      const pcNow = () => campaign.activeCharacter;

      let encounteredError = false;
      const steps = commands.map((cmd) => {
        switch (cmd.kind) {
          case "startTurn":
            pcNow().startTurn();
            break;
          case "nextPlayer":
            campaign.nextPlayer();
            break;
          case "go":
            pcNow().go(cmd.dir);
            break;
          case "attack": {
            const room = pcNow().currentRoom!;
            const mob = [...room.occupants].find(
              (o) => (o.id as unknown as string) === cmd.targetId,
            );
            if (!mob) {
              // Mob may already be defeated (KO'd). Skipping — should not happen.
              encounteredError = true;
              break;
            }
            pcNow().attack(mob);
            break;
          }
          case "take": {
            const room = pcNow().currentRoom!;
            const lootBox = [...room.loot.values()].find(
              (l) => (l.id as unknown as string) === cmd.lootId,
            );
            if (!lootBox) {
              encounteredError = true;
              break;
            }
            if (!opened.has(cmd.lootId)) {
              pcNow().openLootBox(lootBox);
              opened.add(cmd.lootId);
            }
            const item = lootBox.contents.find(
              (i) => (i.id as unknown as string) === cmd.targetId,
            );
            if (!item) {
              encounteredError = true;
              break;
            }
            pcNow().takeFromLootBox(lootBox, [item]);
            break;
          }
        }
        return {
          command: cmd,
          cues: drain(),
          snapshot: structuralClone(serializeCampaign(campaign)),
          view: structuralClone(viewProjected(campaign, ALIASES, opened)),
        };
      });

      if (encounteredError) continue;

      // ── Self-validation (seed coverage gates) ──────────────────────────────

      // (a) An encounter cue for the mob fired.
      // PresentationCue is a discriminated union; the `kind` field is always present.
      if (!steps.some((s) => s.cues.some((c) => c.kind === "encounter"))) continue;

      // (b) A mob codex record + a material codex record exist.
      // codex entries are { kind: string; ... } — access via CampaignSnapshot.codex.
      const anyCodex = (kind: string) =>
        steps.some((s) =>
          (s.snapshot.codex ?? []).some(
            (e) => (e as { kind: string }).kind === kind,
          ),
        );
      if (!anyCodex("mob")) continue;
      if (!anyCodex("material")) continue;

      // (c) campaign.materials gained the deposit.
      if (
        !steps.some(
          (s) => ((s.snapshot.campaign.materials as Record<string, number>)?.["ectoplasm"] ?? 0) > 0,
        )
      ) continue;

      // (d) A `${mob}:remains` loot box exists in world.loot.
      if (
        !steps.some((s) =>
          s.snapshot.loot.some((l) => l.id.endsWith(":remains")),
        )
      ) continue;

      // (e) The mob shows defeated in a view.
      // The view's `occupants` type has a `defeated?: boolean` field.
      if (
        !steps.some((s) =>
          (s.view.occupants as Array<{ defeated?: boolean }>).some((o) => o.defeated === true),
        )
      ) continue;

      // (f) The relic item ended up in Ada's inventory (take succeeded).
      // The snapshot stores inventory as { itemIds: string[] }, not { items: Item[] }.
      const lastSnapshot = steps[steps.length - 1]!.snapshot;
      const relicInInventory = (
        lastSnapshot.characters as Array<{ name: string; inventory: { itemIds: string[] } }>
      ).some((c) => c.name === "Ada" && c.inventory.itemIds.includes(RELIC_ITEM_ID));
      if (!relicInInventory) continue;

      // All assertions pass — record this seed.
      SEED = seed;
      goldenSeed = seed;
      goldenStart = start;
      goldenCatalog = catalog;
      goldenCommands = commands;
      goldenSteps = steps;
      break;
    }

    if (SEED === -1 || !goldenStart || !goldenCatalog || !goldenCommands || !goldenSteps) {
      throw new Error("No seed in 1..500 satisfies all coverage assertions.");
    }

    // ── Self-validation (hard throws): the 6c-4 fractional-deposit proof ────
    //
    // After the KO step, the campaign materials pool MUST carry ectoplasm at
    // EXACTLY 2.5 — a fractional float. 0 would mean the deposit was dropped
    // (the pre-fix Rust behavior this fixture exists to catch); 2 would mean
    // the quantity was truncated to an integer.
    const koStep = goldenSteps.find(
      (s) =>
        ((s.snapshot.campaign.materials as Record<string, number>)?.["ectoplasm"] ?? 0) > 0,
    );
    if (!koStep) {
      throw new Error("material-drop: no step deposited ectoplasm into the campaign pool.");
    }
    const ectoplasm = (koStep.snapshot.campaign.materials as Record<string, number>)["ectoplasm"];
    if (ectoplasm !== 2.5) {
      throw new Error(
        `material-drop: campaign pool ectoplasm is ${String(ectoplasm)}, expected exactly 2.5 ` +
          "(fractional deposit must be preserved verbatim — not 0, not 2).",
      );
    }
    if (Number.isInteger(ectoplasm)) {
      throw new Error("material-drop: deposited ectoplasm quantity is not fractional.");
    }
    const hasEctoplasmCodex = goldenSteps.some((s) =>
      (s.snapshot.codex ?? []).some(
        (e) =>
          (e as { kind: string; key?: string }).kind === "material" &&
          (e as { kind: string; key?: string }).key === "ectoplasm",
      ),
    );
    if (!hasEctoplasmCodex) {
      throw new Error("material-drop: no `material` codex entry for 'ectoplasm' was recorded.");
    }

    // ── Catalog validation ──────────────────────────────────────────────────
    if (Object.keys(goldenCatalog.items).length === 0) {
      throw new Error("Catalog items is empty — no item factories were exported.");
    }
    for (const [key, descriptor] of Object.entries(goldenCatalog.items)) {
      const d = descriptor as Record<string, unknown>;
      for (const field of ["recipe", "teaches", "immunities", "grantsImmunity"]) {
        if (!(field in d)) {
          throw new Error(`Catalog item '${key}' is missing required inert field '${field}'.`);
        }
      }
    }

    // ── Write files ─────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "material-drop.start.snapshot.json"),
      JSON.stringify(goldenStart, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "material-drop.catalog.json"),
      JSON.stringify(goldenCatalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "material-drop.golden.json"),
      JSON.stringify({ seed: goldenSeed, commands: goldenCommands, steps: goldenSteps }, null, 2) + "\n",
    );

    // ── Debug summary ──────────────────────────────────────────────────────
    console.log(
      `[material-drop] SEED=${SEED} steps=${goldenSteps.length}`,
    );
  });
});
