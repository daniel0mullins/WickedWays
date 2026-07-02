/**
 * Combat golden generator — run once to write the committed fixture files.
 *
 * Drives a bespoke combat campaign through a COMMAND STREAM (startTurn / attack
 * / nextPlayer cycles that degrade weapon durability across rounds), capturing
 * per-step { command, cues, snapshot, view }. The engine is driven DIRECTLY:
 * pc.startTurn / pc.attack(target) / campaign.nextPlayer.
 *
 * Seeded RNG is CRITICAL: all affliction clear rolls draw from a SINGLE shared
 * `mulberry32(SEED)` instance — mirroring the Rust World's single `pub rng: Rng`
 * seeded once via `replay_commands(.., seed)`.
 *
 * The start snapshot is serialized AFTER items are equipped but BEFORE the first
 * command. No rng is drawn during equip (no afflictions at boot; no encounters;
 * baseEncounterChance 0).
 *
 * Writes:
 *   - combat.start.snapshot.json   (serialized genesis state, pre-command)
 *   - combat.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - combat.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay (Task 8): each object in
 * `golden.commands` deserializes into the Rust `Command` enum
 * (#[serde(tag="kind", rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "attack", "targetId": "<CharacterId>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import type { CharacterSnapshot } from "wickedways/lib/serialization/types";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

const AXE_KEY = "items/axe";       // weapon, Health+3, maxDurability 2
const CLEAVER_KEY = "items/cleaver"; // weapon, Sanity+4, maxDurability 5
const VEST_KEY = "items/vest";      // armor, Health+1, maxDurability 2
const CHARM_KEY = "items/charm";    // accessory, Sanity+2, no durability

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [AXE_KEY]: ["axe", "hand axe"],
  [CLEAVER_KEY]: ["cleaver", "meat cleaver"],
  [VEST_KEY]: ["vest", "padded vest"],
  [CHARM_KEY]: ["charm", "lucky charm"],
};

// ─── LightAverse subclass (Ben only) ─────────────────────────────────────────

class LightAversePlayer extends PlayerCharacter {
  protected override get lightAverse(): boolean {
    return true;
  }

  protected override serializeExtra(snap: CharacterSnapshot): void {
    super.serializeExtra(snap);
    snap.lightAverse = true;
  }
}

// ─── Item factories ───────────────────────────────────────────────────────────

const noop = () => {};

/** Hand axe: weapon targeting Health, maxDurability 2. */
function makeAxe(): Item {
  return new Item({
    descriptor: {
      behaviorKey: AXE_KEY,
      name: "Hand Axe",
      type: ItemType.Weapon,
      recipe: { item: 1 },
      modifier: 3,
      stat: StatType.Health,
      maxDurability: 2,
      slot: SlotKind.Hand,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/** Meat cleaver: weapon targeting Sanity, maxDurability 5. */
function makeCleaver(): Item {
  return new Item({
    descriptor: {
      behaviorKey: CLEAVER_KEY,
      name: "Meat Cleaver",
      type: ItemType.Weapon,
      recipe: { item: 1 },
      modifier: 4,
      stat: StatType.Sanity,
      maxDurability: 5,
      slot: SlotKind.Hand,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/** Padded vest: armor targeting Health, maxDurability 2. */
function makeVest(): Item {
  return new Item({
    descriptor: {
      behaviorKey: VEST_KEY,
      name: "Padded Vest",
      type: ItemType.Armor,
      recipe: { item: 1 },
      modifier: 1,
      stat: StatType.Health,
      maxDurability: 2,
      slot: SlotKind.Torso,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/** Lucky charm: accessory targeting Sanity, no durability. */
function makeCharm(): Item {
  return new Item({
    descriptor: {
      behaviorKey: CHARM_KEY,
      name: "Lucky Charm",
      type: ItemType.Accessory,
      recipe: { item: 1 },
      modifier: 2,
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
      [AXE_KEY]: makeAxe,
      [CLEAVER_KEY]: makeCleaver,
      [VEST_KEY]: makeVest,
      [CHARM_KEY]: makeCharm,
    },
  });
}

// ─── Catalog exporter (verbatim from afflictions.gen.test.ts) ─────────────────

function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    type: item.type as string,
    stat: item.stat as string,
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
    ...(item.slot !== undefined ? { slot: item.slot as string } : {}),
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

// ─── ViewModel projection helper (verbatim from afflictions.gen.test.ts) ──────

function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]>,
  opened: ReadonlySet<string>,
) {
  const full = view(campaign, aliases, opened);

  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  const { locationName: _locName, ...statusRest } = full.status as { locationName?: unknown; [k: string]: unknown };

  return {
    room: roomRest,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: statusRest,
    outcome: full.outcome,
    finished: full.finished,
  };
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────
//
// Hall (dark: false, no exits). Two PCs injected with a shared seeded rng.
//   Ada (index 0, gm): health=10, sanity=10, energy=10 — fighter archetype.
//   Ben (index 1): health=6, sanity=6, energy=8, lightAverse=true — scout archetype.
//
// Items are equipped AFTER beginCampaign; no afflictions at boot so the gate
// allows equip. No rng is drawn during equip.
function buildCombatCampaign(rng: () => number) {
  const registry = buildItemRegistry();

  const template = authorTemplate("Combat (conformance)", registry, {
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
    .archetype({
      id: "scout",
      name: "Scout",
      baseStats: {
        [StatType.Health]: 6,
        [StatType.Sanity]: 6,
        [StatType.Energy]: 8,
      },
    })
    .room("Hall", { description: "A stone hall." })
    .startRoom("Hall");

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.joinCampaign();
  ada.selectArchetype("fighter" as never);
  ada.move(hall);

  const ben = new LightAversePlayer({ campaign, name: "Ben", rng });
  ben.joinCampaign();
  ben.selectArchetype("scout" as never);
  ben.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry, ada, ben };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "nextPlayer" }
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate combat golden", () => {
  it("writes the combat snapshot, catalog, and golden", () => {
    // Brute-force search for the first seed 1..500 that satisfies all coverage
    // assertions. (Coverage is structurally guaranteed by stat design, so SEED=1
    // works; the loop runs as a formality to match the afflictions template.)
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
      const { campaign, registry, ada, ben } = buildCombatCampaign(rng);

      // ── Equip items ────────────────────────────────────────────────────────
      // Items are equipped during setup (no afflictions → gate allows).
      const axeItem = registry.item(AXE_KEY)();
      const cleaverItem = registry.item(CLEAVER_KEY)();
      ada.addToInventory(axeItem);
      ada.addToInventory(cleaverItem);
      ada.equip(axeItem, EquipmentSlot.LeftHand);
      ada.equip(cleaverItem, EquipmentSlot.RightHand);

      const vestItem = registry.item(VEST_KEY)();
      const charmItem = registry.item(CHARM_KEY)();
      ben.addToInventory(vestItem);
      ben.addToInventory(charmItem);
      ben.equip(vestItem, EquipmentSlot.Torso);
      ben.equip(charmItem, EquipmentSlot.LeftIndexFinger);

      // ── Genesis snapshot (pre-command, items equipped) ─────────────────────
      const start = serializeCampaign(campaign);

      // ── Build catalog ──────────────────────────────────────────────────────
      const itemKeys = [AXE_KEY, CLEAVER_KEY, VEST_KEY, CHARM_KEY];
      const catalog = buildCatalog(registry, itemKeys, ALIASES);

      // ── Cue capture ────────────────────────────────────────────────────────
      let buf: PresentationCue[] = [];
      campaign.onCue((c: PresentationCue) => buf.push(c));
      const drain = () => {
        const out = buf;
        buf = [];
        return out;
      };

      // ── `opened` set (no loot boxes in this campaign) ─────────────────────
      const opened = new Set<string>();

      // ── Resolve Ben's id for the attack commands ───────────────────────────
      const BEN_ID = ben.id as string;

      // ── The command stream ─────────────────────────────────────────────────
      // Party [Ada, Ben], gm=Ada. Ada active first.
      //
      // Ada attacks Ben each round (one attack per round). Weapon durability:
      //   Axe:    maxDurability=2, breaks after attack 2 (round 1)
      //   Cleaver: maxDurability=5, breaks after attack 6 (round 5) — but
      //            Ben is KO'd by that point since cleaver deals Sanity
      //            damage and natural attack covers Health.
      //   Vest:   maxDurability=2 worn by Ben; reduces incoming Health damage.
      //           Wears once per health attack → breaks after 2 health attacks.
      //
      // Ben's stats: health=6, sanity=6 (effective sanity: base+charm=6+2=8).
      // Axe deals Health: mitigated by vest (armor modifier=1, reduced by
      //   Ben's effective mitigator stat). Vest takes 1 durability per attack.
      // Cleaver deals Sanity: mitigated by sanity mitigator (energy-based).
      // After axe breaks (round 1), only cleaver swings → only sanity damage.
      // After vest breaks (rounds 0–1, 2 hits), no armor mitigation.
      //
      // Ben does NOT attack Ada (no weapons; Ben's actions are skipped via nextPlayer).
      //
      // Rounds 0..5 (6 attack rounds), then round 6 Ada startTurn to show Ben KO.
      const commands: Command[] = [
        // Round 0
        { kind: "startTurn" },
        { kind: "attack", targetId: BEN_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "nextPlayer" },
        // Round 1
        { kind: "startTurn" },
        { kind: "attack", targetId: BEN_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "nextPlayer" },
        // Round 2
        { kind: "startTurn" },
        { kind: "attack", targetId: BEN_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "nextPlayer" },
        // Round 3
        { kind: "startTurn" },
        { kind: "attack", targetId: BEN_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "nextPlayer" },
        // Round 4
        { kind: "startTurn" },
        { kind: "attack", targetId: BEN_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "nextPlayer" },
        // Round 5
        { kind: "startTurn" },
        { kind: "attack", targetId: BEN_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "nextPlayer" },
        // Round 6 — show Ben KO in Ada's view
        { kind: "startTurn" },
      ];

      // ── Drive the engine directly, capturing per-step state ─────────────────
      const pcNow = () => campaign.activeCharacter;

      const steps = commands.map((cmd) => {
        switch (cmd.kind) {
          case "startTurn":
            pcNow().startTurn();
            break;
          case "nextPlayer":
            campaign.nextPlayer();
            break;
          case "attack": {
            const target = campaign.party.find((p) => p.id === cmd.targetId)!;
            pcNow().attack(target);
            break;
          }
        }
        return {
          command: cmd,
          cues: drain(),
          snapshot: serializeCampaign(campaign),
          view: viewProjected(campaign, ALIASES, opened),
        };
      });

      // ── Self-validation ────────────────────────────────────────────────────

      // (a) At least one fractional base stat (damage mitigation produces fractional values).
      const anyFractional = steps.some((s) =>
        (s.snapshot.characters as Array<{ stats: Record<string, number> }>).some((c) =>
          ["health", "sanity", "energy"].some((k) => !Number.isInteger(c.stats[k] ?? 0)),
        ),
      );
      if (!anyFractional) continue;

      // (b) Vest breaks (durability reaches 0).
      const armorBroke = steps.some((s) =>
        (s.snapshot.items as Array<{ behaviorKey?: string; durability?: number }>).some(
          (i) => i.behaviorKey === VEST_KEY && i.durability === 0,
        ),
      );
      if (!armorBroke) continue;

      // (c) Both weapons break (axe and cleaver both reach durability 0).
      const bothWeaponsBrokenStep = steps.find((s) =>
        (s.snapshot.items as Array<{ behaviorKey?: string; durability?: number }>).some(
          (i) => i.behaviorKey === AXE_KEY && i.durability === 0,
        ) &&
        (s.snapshot.items as Array<{ behaviorKey?: string; durability?: number }>).some(
          (i) => i.behaviorKey === CLEAVER_KEY && i.durability === 0,
        ),
      );
      if (!bothWeaponsBrokenStep) continue;

      // (d) The NEXT attack after both weapons first reached 0 must produce a new
      // Health takeDamage in Ben's history — proving the natural-attack fallback fired.
      // The check is a per-step DELTA (count before vs after) so it cannot be
      // satisfied by earlier axe attacks that happened while weapons were intact.
      const bothBrokenIdx = steps.indexOf(bothWeaponsBrokenStep);
      const naturalAttackStep = steps.slice(bothBrokenIdx + 1).find(
        (s) => s.command.kind === "attack",
      );
      if (!naturalAttackStep) continue;

      type CharSnapshot = { name: string; history: Array<{ kind: string; stat?: string }> };
      const countBenHealthDamage = (step: (typeof steps)[number]) =>
        (step.snapshot.characters as CharSnapshot[])
          .find((c) => c.name === "Ben")
          ?.history.filter((h) => h.kind === "takeDamage" && h.stat === StatType.Health)
          .length ?? 0;

      const healthDamageCountBefore = countBenHealthDamage(bothWeaponsBrokenStep);
      const healthDamageCountAfter = countBenHealthDamage(naturalAttackStep);
      // Natural attack added exactly one new Health takeDamage entry.
      if (healthDamageCountAfter <= healthDamageCountBefore) continue;

      // (e) Ben reaches KO (defeated: true in some step's view).
      const koSeen = steps.some((s) =>
        (s.view.occupants as Array<{ defeated?: boolean }>).some((o) => o.defeated === true),
      );
      if (!koSeen) continue;

      // (f) Fear latches on Ben (lightAverse in a lit room causes Fear).
      const fearSeen = steps.some((s) =>
        (
          s.snapshot.characters as Array<{
            afflictions?: { active?: Record<string, unknown> };
          }>
        ).some((c) => c.afflictions?.active?.["fear"] === true),
      );
      if (!fearSeen) continue;

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
      join(here, "combat.start.snapshot.json"),
      JSON.stringify(goldenStart, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "combat.catalog.json"),
      JSON.stringify(goldenCatalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "combat.golden.json"),
      JSON.stringify({ seed: goldenSeed, commands: goldenCommands, steps: goldenSteps }, null, 2) + "\n",
    );

    // ── Debug summary ───────────────────────────────────────────────────────
    console.log(
      `[combat] SEED=${SEED} steps=${goldenSteps.length}`,
    );
  });
});
