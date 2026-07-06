/**
 * Mechanics golden generator — run once to write the committed fixture files.
 *
 * Drives a bespoke single-PC campaign with the `conformance:dread` mechanic
 * enabled through a COMMAND STREAM that exercises every mechanic fire-point:
 *   startTurn   → onTurnStart   ("The dread watches.")
 *   attack      → modifyDamage  (3.6 pre-cap → Final(3): "conformance:dread
 *                 fixed damage at 3.") + onAction ("The dread notices.")
 *   endTurn     → onTurnEnd     ("The dread recedes.")
 *   nextPlayer  → wraps the single-PC party → endRound: onRoundEnd (ticks 0→1,
 *                 AdjustStat sanity −1 on party[0], "Dread deepens.") then the
 *                 non-terminal round-1 onRoundStart ("Dread stirs.").
 *
 * The TS shadow mechanic below reproduces the Rust `conformance::DREAD` op
 * byte-for-byte (crates/wickedways-core/src/world/mechanics/conformance.rs).
 * The Rust op is compiled under `--features conformance`, which the wasm build
 * used by `pnpm run test:conformance` enables.
 *
 * Seeded RNG is CRITICAL: a SINGLE shared `mulberry32(SEED)` instance —
 * mirroring the Rust World's single `pub rng: Rng` seeded once via
 * `replay_commands(.., seed)`. (No draws actually occur in this stream: the PC
 * is healthy throughout and baseEncounterChance is 0.)
 *
 * The start snapshot is serialized AFTER the dagger is equipped but BEFORE the
 * first command, and carries `mechanics: [{ key: "conformance:dread",
 * state: { ticks: 0 } }]`. `beginCampaign` fires onRoundStart pre-snapshot
 * (cue uncaptured, no state change) — the Rust replay boots from the snapshot,
 * so both sides agree.
 *
 * Damage math for the capped hit (mirrors mob-defeat):
 *   attackStrength = 3 (dagger modifier), armorSum = 0,
 *   mitigator = Ghoul's Sanity (Health is mitigated by Sanity) = 4
 *   damage = 3 * max(0, 10 − 4) * 0.2 = 3.6  → modifyDamage caps at 3 (final)
 *   Ghoul health 4 − 3 = 1 (alive; no KO complexity).
 *
 * Writes:
 *   - mechanics.start.snapshot.json   (serialized genesis state, pre-command)
 *   - mechanics.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - mechanics.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "endTurn" } | { "kind": "nextPlayer" }
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
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import type { PresentationCue } from "wickedways/lib/presentation";
import { DREAD_KEY, dreadShadow } from "./dread-shadow.ts";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

/** Dagger: weapon, Health+3, maxDurability 5 (never breaks in this short stream). */
const DAGGER_KEY = "items/dagger";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [DAGGER_KEY]: ["dagger", "iron dagger"],
};

// ─── TS shadow of the Rust `conformance:dread` op ─────────────────────────────
//
// Shared across all mechanics fixtures — see dread-shadow.ts. MUST match
// crates/wickedways-core/src/world/mechanics/conformance.rs byte-for-byte.

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

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildFixtureRegistry() {
  return defineRegistry({
    items: {
      [DAGGER_KEY]: makeDagger,
    },
    mechanics: {
      [DREAD_KEY]: dreadShadow,
    },
  });
}

// ─── Catalog exporter (verbatim from mob-defeat.gen.test.ts) ─────────────────

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
  registry: ReturnType<typeof buildFixtureRegistry>,
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
// Hall (start, lit) holds a resident Ghoul (health=4, sanity=4, energy=4).
// Player: Ada (health=10, sanity=10, energy=10), equipped with an Iron Dagger.
// `.useMechanic("conformance:dread")` opts the campaign into the mechanic, so
// the serialized snapshot carries mechanics: [{ key, state: { ticks: 0 } }].
//
// The Ghoul is authored in the START room, so its encounter cue + mob codex
// record fire during setup (pre-snapshot) and are baked into the genesis state.
function buildMechanicsCampaign(rng: () => number) {
  const registry = buildFixtureRegistry();

  const template = authorTemplate("Mechanics (conformance)", registry, {
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
    .startRoom("Hall")
    .mob("Ghoul", {
      stats: {
        [StatType.Health]: 4,
        [StatType.Sanity]: 4,
        [StatType.Energy]: 4,
      },
      room: "Hall",
    })
    .useMechanic(DREAD_KEY);

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("fighter" as never);
  ada.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry, ada };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "endTurn" }
  | { kind: "nextPlayer" }
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate mechanics golden", () => {
  it("writes the mechanics snapshot, catalog, and golden", () => {
    // Fixed seed: this stream draws NO rng (healthy PC, lit room, no encounter
    // rolls), so any seed yields the same golden. Coverage is asserted below
    // with hard throws instead of a seed search.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign, registry, ada } = buildMechanicsCampaign(rng);

    // ── Equip the dagger ─────────────────────────────────────────────────────
    // Equipped during setup (no afflictions → gate allows; no rng drawn).
    const daggerItem = registry.item(DAGGER_KEY)();
    daggerItem.id = `player:Ada:item#${DAGGER_KEY}` as ItemId;
    ada.addToInventory(daggerItem);
    ada.equip(daggerItem, EquipmentSlot.LeftHand);

    // ── Genesis snapshot (pre-command, dagger equipped) ──────────────────────
    const start = serializeCampaign(campaign);

    // The snapshot must carry the mechanic's initial state.
    const startMechanics = start.campaign.mechanics;
    if (
      startMechanics.length !== 1 ||
      startMechanics[0]!.key !== DREAD_KEY ||
      JSON.stringify(startMechanics[0]!.state) !== JSON.stringify({ ticks: 0 })
    ) {
      throw new Error(
        `Start snapshot mechanics mismatch: ${JSON.stringify(startMechanics)}`,
      );
    }

    // ── Build catalog ────────────────────────────────────────────────────────
    const catalog = buildCatalog(registry, [DAGGER_KEY], ALIASES);

    // ── Cue capture ──────────────────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── `opened` set (no loot boxes in this campaign) ────────────────────────
    const opened = new Set<string>();

    // ── Resolve Ghoul id for the attack command ──────────────────────────────
    // Mob authored via assembler's mobs list → id = "mob:Ghoul"
    const GHOUL_ID = "mob:Ghoul";

    // ── The command stream ───────────────────────────────────────────────────
    //
    // Round 0, Ada's turn (actionsPerRound=3 — one attack stays below cap, so
    // no premature auto-end; endTurn is explicit):
    //   startTurn         → onTurnStart  "The dread watches."
    //   attack(Ghoul)     → modifyDamage caps 3.6 → 3 (diagnostic cue) +
    //                       onAction "The dread notices."  [budget 1/3]
    //   endTurn           → onTurnEnd    "The dread recedes."
    //   nextPlayer        → wraps → endRound: onRoundEnd (ticks 0→1,
    //                       AdjustStat Ada sanity 10→9, "Dread deepens.") →
    //                       round 1 < maxRounds 20 (non-terminal) →
    //                       onRoundStart "Dread stirs."
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "attack", targetId: GHOUL_ID },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
    ];

    // ── Drive the engine directly, capturing per-step state ──────────────────
    const pcNow = () => campaign.activeCharacter;

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "endTurn":
          pcNow().endTurn();
          break;
        case "nextPlayer":
          campaign.nextPlayer();
          break;
        case "attack": {
          const room = pcNow().currentRoom!;
          const mob = [...room.occupants].find(
            (o) => (o.id as unknown as string) === cmd.targetId,
          );
          if (!mob) throw new Error(`Attack target '${cmd.targetId}' not found.`);
          pcNow().attack(mob);
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

    // ── Self-validation (hard throws — the stream is deterministic) ──────────

    const mechanicTexts = (step: (typeof steps)[number]): string[] =>
      step.cues
        .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
        .map((c) => c.cue.text ?? "");

    const expectTexts = (i: number, want: string[]) => {
      const got = mechanicTexts(steps[i]!);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(
          `Step ${i} mechanic cues mismatch: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
        );
      }
    };

    // (a) Each fire-point emitted exactly its expected cue(s), in order.
    expectTexts(0, ["The dread watches."]);
    expectTexts(1, ["conformance:dread fixed damage at 3.", "The dread notices."]);
    expectTexts(2, ["The dread recedes."]);
    expectTexts(3, ["Dread deepens.", "Dread stirs."]);

    type CharSnap = { name: string; stats: Record<string, number>; actionsThisRound: number };
    const charIn = (i: number, name: string): CharSnap => {
      const c = (steps[i]!.snapshot.characters as CharSnap[]).find((x) => x.name === name);
      if (!c) throw new Error(`Character '${name}' missing from step ${i} snapshot.`);
      return c;
    };

    // (b) The capped hit landed for exactly 3: Ghoul health 4 → 1.
    if (charIn(1, "Ghoul").stats[StatType.Health] !== 1) {
      throw new Error(
        `Ghoul health after capped hit should be 1, got ${charIn(1, "Ghoul").stats[StatType.Health]}`,
      );
    }

    // (c) One budgeted action — below the cap of 3, so no auto endTurn at step 1
    //     (its cues carry no "The dread recedes.").
    if (charIn(1, "Ada").actionsThisRound !== 1) {
      throw new Error(
        `Ada should have 1 budgeted action after the attack, got ${charIn(1, "Ada").actionsThisRound}`,
      );
    }

    // (d) onRoundEnd mutated persistent state (ticks 0 → 1) and adjusted
    //     party[0]'s sanity by −1 (10 → 9); the round advanced non-terminally.
    const finalSnap = steps[3]!.snapshot;
    const finalMechanics = finalSnap.campaign.mechanics;
    if (JSON.stringify(finalMechanics[0]!.state) !== JSON.stringify({ ticks: 1 })) {
      throw new Error(`Mechanic state after round end should be {ticks:1}, got ${JSON.stringify(finalMechanics[0]!.state)}`);
    }
    if (charIn(3, "Ada").stats[StatType.Sanity] !== 9) {
      throw new Error(`Ada sanity after round end should be 9, got ${charIn(3, "Ada").stats[StatType.Sanity]}`);
    }
    if (finalSnap.campaign.round !== 1) {
      throw new Error(`Round should be 1 after the wrap, got ${finalSnap.campaign.round}`);
    }
    if (finalSnap.campaign.outcome !== "ongoing") {
      throw new Error(`Campaign should be ongoing (non-terminal), got '${finalSnap.campaign.outcome}'`);
    }

    // ── Catalog validation ────────────────────────────────────────────────────
    if (Object.keys(catalog.items).length === 0) {
      throw new Error("Catalog items is empty — no item factories were exported.");
    }
    for (const [key, descriptor] of Object.entries(catalog.items)) {
      const d = descriptor as Record<string, unknown>;
      for (const field of ["recipe", "teaches", "immunities", "grantsImmunity"]) {
        if (!(field in d)) {
          throw new Error(`Catalog item '${key}' is missing required inert field '${field}'.`);
        }
      }
    }

    // ── Write files ───────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "mechanics.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mechanics.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mechanics.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ─────────────────────────────────────────────────────────
    console.log(`[mechanics] SEED=${SEED} steps=${steps.length}`);
  });
});
