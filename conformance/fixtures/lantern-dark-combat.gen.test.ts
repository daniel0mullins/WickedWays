/**
 * Lantern-dark-combat golden generator — run once to write the committed fixture files.
 *
 * The MIRROR IMAGE of the sees-in-dark fixture. There, a `seesInDark` attacker
 * bypasses the dark-visibility gate in a genuinely UNLIT room. Here, a PLAIN
 * player (NOT seesInDark) equips a light-emitting Brass Lantern in a hand slot,
 * which LIGHTS the dark Cellar via occupant-carried light — so the room's
 * `isLit` is TRUE and the attack lands. This is the exact rule ported into the
 * Rust core in this task:
 *   - TS oracle: `room.ts` `get isLit` (:206-212) → `character.ts` `get hasLight`
 *     (:275-281) → `requireVisibleTarget` (character.ts:266-272) passes.
 *   - Rust: `is_lit` (movement.rs) folds in occupant `character_has_light`, so
 *     `require_visible_target` (combat.rs) no longer throws "Cannot attack in the
 *     dark".
 *
 * DIVERGENCE GATED (RED→GREEN): before the port, the Rust `is_lit` ignored the
 * equipped lantern → the attack command errored with "Cannot attack in the dark"
 * (replay_commands returns Err → the differential test throws) AND the projected
 * `view.room.isLit` was `false` in Rust vs `true` in TS. After the port, both
 * sides agree byte-for-byte.
 *
 * NO ENCOUNTER FORMATION (baseEncounterChance 0) and full PC stats: this fixture
 * draws ZERO rng — no affliction latches, the encounter table is empty, and the
 * mob never acts (the golden direct-drives `attack()`, not the mob-reaction
 * dispatch). SEED is therefore fixed at 1; every self-validation is a hard throw.
 *
 * The start snapshot is serialized AFTER the dagger + lantern are equipped but
 * BEFORE the first command. No rng is drawn during setup.
 *
 * Writes:
 *   - lantern-dark-combat.start.snapshot.json
 *   - lantern-dark-combat.catalog.json
 *   - lantern-dark-combat.golden.json
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum:
 *   { "kind": "startTurn" } | { "kind": "attack", "targetId": "<CharacterId>" }
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
import type { ItemId } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import type { PresentationCue } from "wickedways/lib/presentation";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

/** Dagger: weapon, Health+3, maxDurability 5 (never breaks in this short stream). */
const DAGGER_KEY = "items/dagger";
/** Brass Lantern: accessory hand item that emits light; no durability → never broken. */
const LANTERN_KEY = "items/lantern";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [DAGGER_KEY]: ["dagger", "iron dagger"],
  [LANTERN_KEY]: ["lantern", "brass lantern"],
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

/** Brass lantern: accessory hand item, emitsLight true, NO durability (never broken). */
function makeLantern(): Item {
  return new Item({
    descriptor: {
      behaviorKey: LANTERN_KEY,
      name: "Brass Lantern",
      type: ItemType.Accessory,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Sanity,
      slot: SlotKind.Hand,
      emitsLight: true,
    },
    properties: { equippable: true, equipped: false, destroyable: false, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildItemRegistry() {
  return defineRegistry({
    items: {
      [DAGGER_KEY]: makeDagger,
      [LANTERN_KEY]: makeLantern,
    },
  });
}

// ─── Catalog exporter (verbatim from sees-in-dark.gen.test.ts) ───────────────

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
// Cellar (start, dark: true — no placed light sources). Player: Ada (plain
// PlayerCharacter; health=10, sanity=10, energy=10), Iron Dagger + Brass Lantern.
// Ghoul (mob, plain): health=4, sanity=4, energy=4, pre-placed in the Cellar.
//
// The lantern equipped in a hand slot lights the otherwise-dark Cellar
// (occupant-carried light) → room.isLit === true → the attack is legal.
//
// Damage for the one dagger attack (lit room, no armor, no lightAverse):
//   attackStrength = 3 (dagger modifier)
//   mitigator = Ghoul's Sanity (Health mitigated by Sanity) = 4
//   damage = 3 * max(0, 10 - 4) * 0.2 = 3 * 1.2 = 3.6
//   Ghoul health: 4 - 3.6 = 0.4 (fractional, still standing — no KO machinery, no rng)

function buildCampaign(rng: () => number) {
  const registry = buildItemRegistry();

  const template = authorTemplate("Lantern Dark Combat (conformance)", registry, {
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
    .room("Cellar", { description: "A pitch-black cellar.", dark: true })
    .startRoom("Cellar")
    .mob("Ghoul", {
      stats: {
        [StatType.Health]: 4,
        [StatType.Sanity]: 4,
        [StatType.Energy]: 4,
      },
      room: "Cellar",
    });

  const { campaign, rooms } = assemble(template.description, template.registry);
  const cellar = rooms.get("Cellar")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("fighter" as never);
  ada.move(cellar);

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry, ada, cellar };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate lantern-dark-combat golden", () => {
  it("writes the lantern-dark-combat snapshot, catalog, and golden", () => {
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign, registry, ada, cellar } = buildCampaign(rng);

    // ── Equip the dagger (left hand) + lantern (right hand) ────────────────
    const daggerItem = registry.item(DAGGER_KEY)();
    daggerItem.id = `player:Ada:item#${DAGGER_KEY}` as ItemId;
    ada.addToInventory(daggerItem);
    ada.equip(daggerItem, EquipmentSlot.LeftHand);

    const lanternItem = registry.item(LANTERN_KEY)();
    lanternItem.id = `player:Ada:item#${LANTERN_KEY}` as ItemId;
    ada.addToInventory(lanternItem);
    ada.equip(lanternItem, EquipmentSlot.RightHand);

    // ── Structural invariants (hard throws) ───────────────────────────────
    if (!cellar.dark) {
      throw new Error("Self-validation: the Cellar must be authored dark.");
    }
    if (!cellar.isLit) {
      throw new Error(
        "Self-validation: the Cellar must be lit by the occupant's equipped lantern (isLit === true).",
      );
    }
    if (ada.seesInDark) {
      throw new Error("Self-validation: the attacker must NOT see in the dark (relies on lantern light).");
    }

    // ── Genesis snapshot (pre-command, dagger + lantern equipped) ──────────
    const start = structuralClone(serializeCampaign(campaign));

    type CharSnap = {
      name: string;
      equipment: Record<string, string>;
      stats: Record<string, number>;
      history: Array<{ kind: string; stat?: string }>;
    };
    const adaStart = (start.characters as CharSnap[]).find((c) => c.name === "Ada");
    if (!adaStart || Object.keys(adaStart.equipment).length < 2) {
      throw new Error("Self-validation: Ada's genesis snapshot must carry both equipped items.");
    }

    // ── Build catalog ──────────────────────────────────────────────────────
    const catalog = buildCatalog(registry, [DAGGER_KEY, LANTERN_KEY], ALIASES);
    if (catalog.items[LANTERN_KEY] === undefined
      || (catalog.items[LANTERN_KEY] as { emitsLight?: boolean }).emitsLight !== true) {
      throw new Error("Self-validation: the lantern catalog entry must carry emitsLight: true.");
    }

    // ── Cue capture ────────────────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    const opened = new Set<string>();
    const GHOUL_ID = "mob:Ghoul";

    // ── The command stream: startTurn, then ONE attack in the (lit) dark ────
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "attack", targetId: GHOUL_ID },
    ];

    const pcNow = () => campaign.activeCharacter;

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "attack": {
          const room = pcNow().currentRoom!;
          const mob = [...room.occupants].find(
            (o) => (o.id as unknown as string) === cmd.targetId,
          );
          if (!mob) {
            throw new Error(`Self-validation: attack target ${cmd.targetId} not in room.`);
          }
          pcNow().attack(mob);
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

    // ── Self-validation (hard throws) ──────────────────────────────────────

    // (a) The room was LIT (by the lantern) at every step — the attack really
    // happened in a lantern-lit dark room.
    for (const [i, s] of steps.entries()) {
      if ((s.view.room as { isLit?: boolean }).isLit !== true) {
        throw new Error(`Self-validation: room must be lit at step ${i} (view.room.isLit !== true).`);
      }
    }

    // (b) The attack step emitted the attack action cue.
    const attackStep = steps[steps.length - 1]!;
    const attackCue = attackStep.cues.some(
      (c) => (c as { kind: string; action?: string }).kind === "action"
        && (c as { kind: string; action?: string }).action === "attack",
    );
    if (!attackCue) {
      throw new Error("Self-validation: the attack step must emit an { kind: 'action', action: 'attack' } cue.");
    }

    // (c) The attack LANDED: the Ghoul took mitigated Health damage (4 → 0.4).
    const ghoul = (attackStep.snapshot.characters as CharSnap[]).find((c) => c.name === "Ghoul");
    if (!ghoul) throw new Error("Self-validation: Ghoul missing from the attack-step snapshot.");
    const ghoulHealth = ghoul.stats["health"];
    if (ghoulHealth === undefined || ghoulHealth >= 4 || ghoulHealth <= 0) {
      throw new Error(
        `Self-validation: Ghoul health must have dropped below 4 but stay above 0 (got ${String(ghoulHealth)}).`,
      );
    }
    const tookHealthDamage = ghoul.history.some(
      (h) => h.kind === "takeDamage" && h.stat === StatType.Health,
    );
    if (!tookHealthDamage) {
      throw new Error("Self-validation: Ghoul must record a takeDamage(health) history entry.");
    }

    // (d) The attacker recorded the attack.
    const adaAfter = (attackStep.snapshot.characters as CharSnap[]).find((c) => c.name === "Ada");
    if (!adaAfter?.history.some((h) => h.kind === "attack")) {
      throw new Error("Self-validation: Ada must record the attack in her history.");
    }

    // ── Catalog validation ──────────────────────────────────────────────────
    for (const [key, descriptor] of Object.entries(catalog.items)) {
      const d = descriptor as Record<string, unknown>;
      for (const field of ["recipe", "teaches", "immunities", "grantsImmunity"]) {
        if (!(field in d)) {
          throw new Error(`Catalog item '${key}' is missing required inert field '${field}'.`);
        }
      }
    }

    // ── Write files ─────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "lantern-dark-combat.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "lantern-dark-combat.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "lantern-dark-combat.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    console.log(`[lantern-dark-combat] SEED=${SEED} steps=${steps.length}`);
  });
});
