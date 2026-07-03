/**
 * Mechanics turn-end golden generator — run once to write the committed fixture
 * files.
 *
 * Proves the 6a-2 turn-end faithfulness fix end-to-end: a mob seeded AT its
 * action cap (`actionsThisRound === actionsPerRound`) fires its own `endTurn`
 * from inside `takeDamage`'s unconditional cap-check, and turn hooks dispatch
 * for the NON-PARTY (mob) actor — `conformance:dread.onTurnEnd` emits
 * "The dread recedes." mid-attack, BEFORE the attacker's own attack action cue.
 *
 * Oracle cue order inside the attack step (all from one `attack` command):
 *   1. mechanic  "conformance:dread fixed damage at 3."  (TRANSFORM_DAMAGE,
 *      inside the Ghoul's takeDamage, pre-application)
 *   2. action    takeDamage (actor = mob:Ghoul)           (recordAction cue)
 *   3. mechanic  "The dread recedes."                     (cap-check → mob
 *      endTurn → DISPATCH_TURN("end", mob) → onTurnEnd)
 *   4. action    attack (actor = player:Ada)              (attacker's own
 *      recordAction)
 *   5. mechanic  "The dread notices."                     (onAction)
 *
 * The TS shadow mechanic below reproduces the Rust `conformance::DREAD` op
 * byte-for-byte (crates/wickedways-core/src/world/mechanics/conformance.rs),
 * verbatim from mechanics.gen.test.ts. The Rust op is compiled under
 * `--features conformance`, which the wasm build used by
 * `pnpm run test:conformance` enables.
 *
 * The Ghoul is seeded at cap by writing `actionsThisRound = actionsPerRound`
 * on the LIVE mob BEFORE the start snapshot is serialized, so both the TS
 * oracle and the Rust replay (which boots from the snapshot) agree on the
 * at-cap state. Mob `endTurn` does NOT reset the budget (only `startTurn`
 * does), so the post-attack snapshot still shows the mob at cap.
 *
 * Damage math for the capped hit (mirrors mechanics.gen.test.ts):
 *   attackStrength = 3 (dagger modifier), armorSum = 0,
 *   mitigator = Ghoul's Sanity (Health is mitigated by Sanity) = 4
 *   damage = 3 * max(0, 10 − 4) * 0.2 = 3.6  → modifyDamage caps at 3 (final)
 *   Ghoul health 4 − 3 = 1 → SURVIVES (the step is about the mob's turn-end,
 *   not a KO/drop).
 *
 * Seeded RNG is CRITICAL: a SINGLE shared `mulberry32(SEED)` instance —
 * mirroring the Rust World's single `pub rng: Rng` seeded once via
 * `replay_commands(.., seed)`. (No draws actually occur in this stream: the PC
 * is healthy throughout and baseEncounterChance is 0.)
 *
 * Writes:
 *   - mechanics-turnend.start.snapshot.json  (serialized genesis state, mob at cap)
 *   - mechanics-turnend.catalog.json         ({ items, aliases } Rust Catalog shape)
 *   - mechanics-turnend.golden.json          ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "attack", "targetId": "<CharacterId>" }
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
import type { Campaign } from "wickedways/lib/campaign";
import { DREAD_KEY, dreadShadow } from "./dread-shadow.ts";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

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

// ─── Catalog exporter (verbatim from mechanics.gen.test.ts) ──────────────────

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

// ─── ViewModel projection helper (verbatim from mechanics.gen.test.ts) ────────

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
// Hall (start, lit) holds a resident Ghoul (health=4, sanity=4, energy=4).
// Player: Ada (health=10, sanity=10, energy=10), equipped with an Iron Dagger.
// `.useMechanic("conformance:dread")` opts the campaign into the mechanic, so
// the serialized snapshot carries mechanics: [{ key, state: { ticks: 0 } }].
//
// The Ghoul is authored in the START room, so its encounter cue + mob codex
// record fire during setup (pre-snapshot) and are baked into the genesis state.
function buildTurnEndCampaign(rng: () => number) {
  const registry = buildFixtureRegistry();

  const template = authorTemplate("Mechanics Turn-End (conformance)", registry, {
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

  return { campaign, registry, ada, hall };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate mechanics-turnend golden", () => {
  it("writes the mechanics-turnend snapshot, catalog, and golden", () => {
    // Fixed seed: this stream draws NO rng (healthy PC, lit room, no encounter
    // rolls), so any seed yields the same golden. Coverage is asserted below
    // with hard throws instead of a seed search.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign, registry, ada, hall } = buildTurnEndCampaign(rng);

    // ── Equip the dagger ─────────────────────────────────────────────────────
    // Equipped during setup (no afflictions → gate allows; no rng drawn).
    const daggerItem = registry.item(DAGGER_KEY)();
    daggerItem.id = `player:Ada:item#${DAGGER_KEY}` as ItemId;
    ada.addToInventory(daggerItem);
    ada.equip(daggerItem, EquipmentSlot.LeftHand);

    // ── Resolve the Ghoul and seed it AT its action cap ──────────────────────
    // Mob authored via assembler's mobs list → id = "mob:Ghoul".
    // `actionsThisRound` is protected (compile-time only), so seed it through a
    // structural cast on the LIVE mob BEFORE serializing the start snapshot —
    // both the TS oracle and the Rust replay (booting from the snapshot) then
    // agree the mob is at cap, and the PC's attack drives the mob's takeDamage
    // through the cap-check into the mob's endTurn.
    const GHOUL_ID = "mob:Ghoul";
    const ghoul = [...hall.occupants].find(
      (o) => (o.id as unknown as string) === GHOUL_ID,
    );
    if (!ghoul) throw new Error(`Ghoul '${GHOUL_ID}' not found in the Hall.`);
    const ghoulBudget = ghoul as unknown as {
      actionsPerRound: number;
      actionsThisRound: number;
    };
    if (ghoulBudget.actionsPerRound <= 0) {
      throw new Error(
        `Ghoul actionsPerRound must be positive to seed an at-cap state, got ${ghoulBudget.actionsPerRound}`,
      );
    }
    ghoulBudget.actionsThisRound = ghoulBudget.actionsPerRound;

    // ── Genesis snapshot (pre-command, dagger equipped, Ghoul at cap) ────────
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

    // The snapshot must carry the Ghoul AT CAP — this is the whole point of the
    // fixture. A degenerate regeneration (mob below cap) must never go green.
    type CharSnap = {
      name: string;
      stats: Record<string, number>;
      actionsPerRound: number;
      actionsThisRound: number;
    };
    const startGhoul = (start.characters as CharSnap[]).find((c) => c.name === "Ghoul");
    if (!startGhoul) throw new Error("Ghoul missing from the start snapshot.");
    if (
      startGhoul.actionsThisRound !== startGhoul.actionsPerRound ||
      startGhoul.actionsThisRound <= 0
    ) {
      throw new Error(
        `Start snapshot must seed the Ghoul at cap: actionsThisRound=${startGhoul.actionsThisRound}, actionsPerRound=${startGhoul.actionsPerRound}`,
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

    // ── The command stream ───────────────────────────────────────────────────
    //
    // Round 0, Ada's turn (actionsPerRound=3 — one attack stays below cap, so
    // no attacker auto-end; the ONLY endTurn in this stream is the Ghoul's
    // cap-triggered one inside takeDamage):
    //   startTurn         → onTurnStart  "The dread watches."   (Ada)
    //   attack(Ghoul)     → modifyDamage caps 3.6 → 3 (diagnostic cue)
    //                       → Ghoul takeDamage action cue
    //                       → Ghoul AT CAP → Ghoul.endTurn → onTurnEnd
    //                         "The dread recedes."              (MOB actor)
    //                       → Ada attack action cue
    //                       → onAction "The dread notices."     (Ada)
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "attack", targetId: GHOUL_ID },
    ];

    // ── Drive the engine directly, capturing per-step state ──────────────────
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

    // (a) Each fire-point emitted exactly its expected cue(s), in order. The
    //     attack step MUST carry "The dread recedes." — the mob's cap-triggered
    //     turn-end hook — between the damage diagnostic and the onAction cue.
    expectTexts(0, ["The dread watches."]);
    expectTexts(1, [
      "conformance:dread fixed damage at 3.",
      "The dread recedes.",
      "The dread notices.",
    ]);

    // (b) Full cue ORDER inside the attack step: the Ghoul's takeDamage action
    //     cue, then the mob turn-end "recedes" cue, then Ada's attack action
    //     cue (takeDamage/turn-end cues precede the attacker's own action cue).
    const attackCues = steps[1]!.cues;
    const idxOf = (pred: (c: PresentationCue) => boolean, label: string): number => {
      const i = attackCues.findIndex(pred);
      if (i === -1) throw new Error(`Attack step is missing expected cue: ${label}`);
      return i;
    };
    const iTakeDamage = idxOf(
      (c) => c.kind === "action" && c.action === "takeDamage" && c.actor.id === GHOUL_ID,
      "takeDamage action cue (actor mob:Ghoul)",
    );
    const iRecedes = idxOf(
      (c) => c.kind === "mechanic" && c.cue.text === "The dread recedes.",
      '"The dread recedes." mechanic cue',
    );
    const iAttack = idxOf(
      (c) => c.kind === "action" && c.action === "attack" && c.actor.id === "player:Ada",
      "attack action cue (actor player:Ada)",
    );
    if (!(iTakeDamage < iRecedes && iRecedes < iAttack)) {
      throw new Error(
        `Attack step cue order wrong: takeDamage@${iTakeDamage} < recedes@${iRecedes} < attack@${iAttack} must hold.`,
      );
    }

    const charIn = (i: number, name: string): CharSnap => {
      const c = (steps[i]!.snapshot.characters as CharSnap[]).find((x) => x.name === name);
      if (!c) throw new Error(`Character '${name}' missing from step ${i} snapshot.`);
      return c;
    };

    // (c) The capped hit landed for exactly 3 and the Ghoul SURVIVED
    //     (health 4 → 1): this step is about the mob's turn-end, not a KO/drop.
    if (charIn(1, "Ghoul").stats[StatType.Health] !== 1) {
      throw new Error(
        `Ghoul health after capped hit should be 1 (alive), got ${charIn(1, "Ghoul").stats[StatType.Health]}`,
      );
    }

    // (d) The Ghoul is STILL at cap after its endTurn (only startTurn resets
    //     the budget) — proving the recedes cue came from the cap-check path.
    const ghoulAfter = charIn(1, "Ghoul");
    if (ghoulAfter.actionsThisRound !== ghoulAfter.actionsPerRound) {
      throw new Error(
        `Ghoul should remain at cap post-attack: actionsThisRound=${ghoulAfter.actionsThisRound}, actionsPerRound=${ghoulAfter.actionsPerRound}`,
      );
    }

    // (e) Ada spent exactly one budgeted action — below her cap of 3, so the
    //     recedes cue cannot be Ada's own auto-endTurn.
    if (charIn(1, "Ada").actionsThisRound !== 1) {
      throw new Error(
        `Ada should have 1 budgeted action after the attack, got ${charIn(1, "Ada").actionsThisRound}`,
      );
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
      join(here, "mechanics-turnend.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mechanics-turnend.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mechanics-turnend.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ─────────────────────────────────────────────────────────
    console.log(`[mechanics-turnend] SEED=${SEED} steps=${steps.length}`);
  });
});
