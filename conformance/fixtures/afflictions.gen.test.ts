/**
 * Afflictions golden generator — run once to write the committed fixture files.
 *
 * Drives a bespoke affliction campaign through a COMMAND STREAM (startTurn cycles
 * that tick the affliction RNG frame + a `use` immunity grant + a Confused-gated
 * `take` that fizzles), capturing per-step { command, cues, snapshot, view }.
 * The engine is driven DIRECTLY (as turn-movement / items-actions do — NOT
 * GameSession.execute): pc.startTurn / campaign.nextPlayer / pc.takeFromLootBox /
 * item.actions.use.
 *
 * Seeded RNG is CRITICAL: the whole affliction frame (clear rolls at each
 * startTurn, the Confused fizzle at the gate) draws from a SINGLE shared
 * `mulberry32(SEED)` instance — mirroring the Rust World's single `pub rng: Rng`
 * seeded once via `replay_commands(.., seed)`. All player characters therefore
 * share the same rng instance, and `SEED` is recorded at the top of the golden so
 * Task 8 seeds `mulberry32(SEED)` identically.
 *
 * The start snapshot is serialized BEFORE the first startTurn, so no rng is drawn
 * before it (nothing draws at boot in 4a — no encounters; baseEncounterChance 0).
 *
 * Writes:
 *   - afflictions.start.snapshot.json   (serialized genesis state, pre-command)
 *   - afflictions.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - afflictions.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * The main test:conformance gate excludes conformance/fixtures/** so this
 * generator never runs as part of the replay gate.
 *
 * Interface contract with the Rust replay (Task 8): each object in
 * `golden.commands` deserializes into the Rust `Command` enum
 * (#[serde(tag="kind", rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "take"|"use", "targetId": "<ITEM id>" }
 * The TS driver resolves `targetId` → the live IItem/ILoot by id.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Seed ──────────────────────────────────────────────────────────────────
// Chosen so the stream exercises every required affliction event under a single
// shared mulberry32 stream (see the self-validation throws at the bottom).
const SEED = 165;

// ─── Item behavior keys ───────────────────────────────────────────────────────

const TALISMAN_KEY = "items/calming-talisman"; // usable → grants panic immunity
const TRINKET_KEY = "items/loose-trinket"; // plain take target (fizzle victim)

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [TALISMAN_KEY]: ["talisman", "calming talisman", "charm"],
  [TRINKET_KEY]: ["trinket", "loose trinket"],
};

// ─── Item factories ───────────────────────────────────────────────────────────

const noop = () => {};

/** A usable consumable that grants Panic immunity for 2 turns on use. */
function makeCalmingTalisman(): Item {
  return new Item({
    descriptor: {
      behaviorKey: TALISMAN_KEY,
      name: "Calming Talisman",
      type: ItemType.Consumable,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Sanity,
      grantsImmunity: { statuses: [Status.Panic], turns: 2 },
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/** A plain, takeable trinket — the victim of the Confused fizzle attempt. */
function makeLooseTrinket(): Item {
  return new Item({
    descriptor: {
      behaviorKey: TRINKET_KEY,
      name: "Loose Trinket",
      type: ItemType.Consumable,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildItemRegistry() {
  return defineRegistry({
    items: {
      [TALISMAN_KEY]: makeCalmingTalisman,
      [TRINKET_KEY]: makeLooseTrinket,
    },
  });
}

// ─── Catalog exporter (verbatim from items-actions.gen.test.ts) ───────────────

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

// ─── 3a ViewModel projection helper (verbatim from items-actions.gen.test.ts) ──

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
// startSession() does NOT thread a seeded rng into the player characters (they
// default to Math.random), so we cannot use it for a determinism-sensitive
// affliction fixture. Instead we assemble the world and construct the PCs
// ourselves, injecting the SAME shared `mulberry32(SEED)` instance into every PC
// (and the campaign), so all affliction draws form a single ordered stream —
// exactly what the Rust World's single `pub rng: Rng` produces.
//
// Rooms: a single lit Hall holding a "shelf" loot container with the talisman +
// trinket. No dark rooms, no encounters (baseEncounterChance 0) → the only rng
// draws are affliction clear rolls (startTurn) and the Confused fizzle (gate).
//
// Player A (active, gm): sanity=0 (→Panic) + energy=0 (→Confused), health=10.
// Player B: health=0 (→KO). Both start in the Hall.
function buildAfflictionsCampaign(rng: () => number) {
  const registry = buildItemRegistry();

  const template = authorTemplate("Afflictions (conformance)", registry, {
    rng,
    maxRounds: 20,
    baseEncounterChance: 0,
  })
    .archetype({
      id: "haunted",
      name: "Haunted",
      // sanity=0 → Panic, energy=0 → Confused, health=10 (alive).
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 0,
        [StatType.Energy]: 0,
      },
    })
    .archetype({
      id: "doomed",
      name: "Doomed",
      // health=0 → KO on first reconcile.
      baseStats: {
        [StatType.Health]: 0,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10,
      },
    })
    .room("Hall", { description: "A cold stone hall." })
    .startRoom("Hall")
    .loot("shelf", {
      room: "Hall",
      items: [TALISMAN_KEY, TRINKET_KEY],
      description: "A dusty shelf.",
    });

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  // Construct the two PCs with the SHARED seeded rng, mirroring startSession's
  // join → selectArchetype → move sequence.
  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("haunted" as never);
  ada.move(hall);

  const ben = new PlayerCharacter({ campaign, name: "Ben", rng });
  ben.id = "player:Ben" as CharacterId;
  ben.joinCampaign();
  ben.selectArchetype("doomed" as never);
  ben.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "nextPlayer" }
  | { kind: "take"; targetId: string }
  | { kind: "use"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate afflictions golden", () => {
  it("writes the afflictions snapshot, catalog, and golden", () => {
    const rng = mulberry32(SEED);
    const { campaign, registry } = buildAfflictionsCampaign(rng);

    // ── Resolve the live item / loot ids from the Hall shelf ────────────────────
    const hall = campaign.activeCharacter.currentRoom!;
    const shelf = [...hall.loot.values()][0]!;
    const idByKey = new Map<string, string>();
    for (const it of shelf.contents) {
      if (it.behaviorKey) idByKey.set(it.behaviorKey, it.id);
    }
    const TALISMAN_ID = idByKey.get(TALISMAN_KEY)!;
    const TRINKET_ID = idByKey.get(TRINKET_KEY)!;
    const SHELF_ID = shelf.id as unknown as string;
    for (const [label, id] of [
      ["talisman", TALISMAN_ID], ["trinket", TRINKET_ID], ["shelf", SHELF_ID],
    ] as const) {
      if (!id) throw new Error(`Failed to resolve ${label} id from the Hall shelf.`);
    }

    // ── Write the genesis snapshot (pre-command, no rng drawn yet) ──────────────
    const start = serializeCampaign(campaign);

    // ── Build the catalog ───────────────────────────────────────────────────────
    const itemKeys = [TALISMAN_KEY, TRINKET_KEY];
    const catalog = buildCatalog(registry, itemKeys, ALIASES);
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

    // ── Cue capture ─────────────────────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── `opened` set (Take auto-adds; no explicit Open in this stream) ──────────
    const opened = new Set<string>();

    // ── The command stream ──────────────────────────────────────────────────────
    // Party [Ada, Ben], gm=Ada. Ada active first.
    //
    // Ada's afflictions latch (Panic+Confused) on her FIRST startTurn (the clear
    // roll loop runs BEFORE apply_from_stats, so turn #1 draws 0). Each later Ada
    // startTurn draws 2 (Panic, Confused) as its clear rolls, growing turnsActive.
    // Ben's KO clears his clearables → his startTurns draw 0.
    //
    // Round 0: Ada.startTurn(#1 latch) → nextPlayer → Ben.startTurn(#1 KO)
    //          → nextPlayer → round 1
    // Rounds 1..N: Ada.startTurn (2 draws each, grows turnsActive → a shakenOff)
    //          → the immunity `use` (clears Panic episode, panic immune 2)
    //          → the Confused `take` fizzle (1 gate draw)
    //          → Ben cycles.
    const commands: Command[] = [
      // Round 0
      { kind: "startTurn" }, // Ada #1 — latch Panic+Confused (0 draws)
      { kind: "nextPlayer" }, // → Ben
      { kind: "startTurn" }, // Ben #1 — KO latches (0 draws)
      { kind: "nextPlayer" }, // → round 1, Ada

      // Round 1
      { kind: "startTurn" }, // Ada #2 — 2 clear rolls
      { kind: "nextPlayer" }, // → Ben
      { kind: "startTurn" }, // Ben #2 — 0 draws (KO)
      { kind: "nextPlayer" }, // → round 2, Ada

      // Round 2
      { kind: "startTurn" }, // Ada #3 — 2 clear rolls (turnsActive grows)
      { kind: "nextPlayer" }, // → Ben
      { kind: "startTurn" }, // Ben #3
      { kind: "nextPlayer" }, // → round 3, Ada

      // Round 3
      { kind: "startTurn" }, // Ada #4 — 2 clear rolls
      { kind: "nextPlayer" }, // → Ben
      { kind: "startTurn" }, // Ben #4
      { kind: "nextPlayer" }, // → round 4, Ada

      // Round 4 — Ada takes the talisman (Confused-gated take; may fizzle here),
      // then uses it (immunity grant → clears Panic episode).
      { kind: "startTurn" }, // Ada #5 — 2 clear rolls
      { kind: "take", targetId: TALISMAN_ID }, // Confused gate roll (allow → take, or fizzle)
      { kind: "use", targetId: TALISMAN_ID }, // grant Panic immunity(2) → clears Panic
      { kind: "nextPlayer" }, // → Ben
      { kind: "startTurn" }, // Ben #5
      { kind: "nextPlayer" }, // → round 5, Ada

      // Round 5 — Ada (Panic now immune, still Confused) attempts a take that
      // FIZZLES on the Confused gate (records a fumble — a diffed step).
      { kind: "startTurn" }, // Ada #6 — Confused clear roll (Panic immune → not rolled)
      { kind: "take", targetId: TRINKET_ID }, // Confused gate → fizzle (fumble)
      { kind: "nextPlayer" }, // → Ben
      { kind: "startTurn" }, // Ben #6
      { kind: "nextPlayer" }, // → round 6, Ada

      // Round 6 — a final Ada step whose VIEW shows Ben defeated:true.
      { kind: "startTurn" }, // Ada #7
    ];

    // ── Drive the engine directly, capturing per-step state ─────────────────────
    const pcNow = () => campaign.activeCharacter;

    const findHeld = (id: string): IItem => {
      const it = pcNow().inventory.items.find((i) => i.id === id);
      if (!it) throw new Error(`Item ${id} not held by active PC.`);
      return it;
    };
    const findInLoot = (id: string): { loot: ILoot; item: IItem } => {
      const room = pcNow().currentRoom!;
      for (const loot of room.loot.values()) {
        const item = loot.contents.find((i) => i.id === id);
        if (item) return { loot, item };
      }
      throw new Error(`Item ${id} not found in any co-located loot container.`);
    };

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "nextPlayer":
          campaign.nextPlayer();
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
          findHeld(cmd.targetId).actions.use(pcNow());
          break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, ALIASES, opened),
      };
    });

    // ── Block attempts (NOT diffed steps; kept out of commands/steps) ───────────
    // These throw ProceduralViolation BEFORE mutating state, so they are safe to
    // attempt on the live campaign; we assert the throw then discard.
    //
    // 1. Ada is Panicked at latch time... but after the round-4 immunity grant she
    //    is no longer Panicked. To prove the Panic-non-move block we replay it on
    //    a FRESH campaign built from the same seed, before the grant. (State-free:
    //    a block throws before mutating, so a fresh instance is the cleanest way to
    //    assert the pre-grant Panic block without disturbing the recorded stream.)
    {
      const rng2 = mulberry32(SEED);
      const { campaign: c2 } = buildAfflictionsCampaign(rng2);
      const ada2 = c2.activeCharacter;
      ada2.startTurn(); // latch Panic+Confused
      const shelf2 = [...ada2.currentRoom!.loot.values()][0]!;
      const trinket2 = shelf2.contents.find((i) => i.behaviorKey === TRINKET_KEY)!;
      // Panicked non-move take → hard block (Panic beats the Confused fizzle roll).
      expect(() => ada2.takeFromLootBox(shelf2, [trinket2])).toThrow(/Panicked/);
    }

    // 2. Ben is KO'd → any action blocks. Assert on the live campaign (throws
    //    before mutating). Ben acted last as active on his round-6 turn? No — the
    //    final recorded command is Ada #7, so Ada is active now. Advance to Ben
    //    and assert his KO block. This mutates turn order only (no rng, no step).
    {
      campaign.nextPlayer(); // → Ben (KO'd)
      const ben = campaign.activeCharacter;
      if (ben.name !== "Ben") {
        throw new Error(`Expected Ben active for the KO block, got "${ben.name}".`);
      }
      const shelf3 = [...ben.currentRoom!.loot.values()][0]!;
      const anyItem = shelf3.contents[0]!;
      expect(() => ben.takeFromLootBox(shelf3, [anyItem])).toThrow(/KO'd/);
      drain(); // discard any cues the doomed attempt produced
    }

    // ── Self-validation (throw if any is false) ─────────────────────────────────

    // (a) ≥1 step with a non-empty snapshot.afflictions.active for the active PC.
    const activeAfflStep = steps.some((s) => {
      const chars = (s.snapshot as { characters?: Array<{ afflictions?: { active?: Record<string, unknown> } }> }).characters ?? [];
      return chars.some((ch) => ch.afflictions && Object.keys(ch.afflictions.active ?? {}).length > 0);
    });
    if (!activeAfflStep) {
      throw new Error("No step has any character with an active affliction.");
    }

    // (b) ≥1 shakenOff entry appearing in some step.
    const shakenOffSeen = steps.some((s) => {
      const chars = (s.snapshot as { characters?: Array<{ afflictions?: { shakenOff?: unknown[] } }> }).characters ?? [];
      return chars.some((ch) => (ch.afflictions?.shakenOff?.length ?? 0) > 0);
    });
    if (!shakenOffSeen) {
      throw new Error("No shakenOff entry appeared in any step (bump the stream / pick another SEED).");
    }

    // (c) an immunity grant that cleared an episode: some step has panic immunity>0
    //     AND panic not active for that same character.
    const immunityClearedPanic = steps.some((s) => {
      const chars = (s.snapshot as { characters?: Array<{ afflictions?: { immunity?: Record<string, number>; active?: Record<string, unknown> } }> }).characters ?? [];
      return chars.some((ch) => {
        const imm = ch.afflictions?.immunity ?? {};
        const active = ch.afflictions?.active ?? {};
        return (imm[Status.Panic] ?? 0) > 0 && !(Status.Panic in active);
      });
    });
    if (!immunityClearedPanic) {
      throw new Error("No step shows panic immunity>0 with panic no longer active (immunity grant did not clear the episode).");
    }

    // (d) ≥1 fumble (fizzle) cue/history in a step.
    const fumbleSeen = steps.some((s) => {
      const inCues = s.cues.some((c) => c.kind === "mechanic" && /fumble/i.test((c as { cue?: { text?: string } }).cue?.text ?? ""));
      const chars = (s.snapshot as { characters?: Array<{ history?: Array<{ kind?: string }> }> }).characters ?? [];
      const inHistory = chars.some((ch) => (ch.history ?? []).some((h) => h.kind === "fumble"));
      return inCues || inHistory;
    });
    if (!fumbleSeen) {
      throw new Error("No fumble (Confused fizzle) appeared in any step (pick a SEED where the gate roll <= 50 on the fizzle attempt).");
    }

    // (e) ≥1 occupant with defeated:true in some step's view (the KO player).
    const defeatedOccupant = steps.some((s) =>
      (s.view.occupants as Array<{ defeated?: boolean }>).some((o) => o.defeated === true),
    );
    if (!defeatedOccupant) {
      throw new Error("No step's view shows an occupant with defeated:true (the KO'd player).");
    }

    // (f) The block attempts threw — asserted above via expect().toThrow().

    // ── Write files ─────────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "afflictions.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "afflictions.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "afflictions.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ───────────────────────────────────────────────────────────
    console.log(
      `[afflictions] SEED=${SEED} talisman=${TALISMAN_ID} trinket=${TRINKET_ID} shelf=${SHELF_ID}`,
    );
  });
});
