/**
 * Keyed-exit golden generator — run once to write the committed fixture files.
 *
 * Proves keyed-exit traversal end-to-end against the Rust `conformance:keyed-door`
 * `ExitBehavior` (crates/wickedways-core/src/world/exits.rs, compiled under
 * `--features conformance`, which the wasm build used by `pnpm run test:conformance`
 * enables). The TS shadow below reproduces the Rust op byte-for-byte:
 *
 *   can_pass:   state.unlocked == true  OR  actor holds an item with
 *               behaviorKey "brass-key"
 *   run_script: iff locked AND holding the key → state.unlocked = true,
 *               returns "The door unlocks." (unlock-once); otherwise None
 *   pass_message: "You pass through."   fail_message: "The door is locked."
 *
 * `hasItem` parity note: the Rust `CharacterView::has_item` matches on the
 * behavior_key of `ItemSnapshot::Item`s reachable from the inventory (key items
 * carry no behavior_key and resolve None), so the TS shadow checks
 * `character.inventory.items.some(i => i.behaviorKey === "brass-key")`.
 *
 * Map: Hall (lit, start) ── North / conformance:keyed-door {unlocked:false} ── Vault.
 * A single authored exit is registered bidirectionally (assembler auto-reverse),
 * so the round-1 return trip traverses the SAME exit and observes the persisted
 * `unlocked` flag.
 *
 * Command stream (single PC, Ada):
 *   Round 0: startTurn; go North (NO key → "The door is locked.", no move);
 *            take brass-key (from the Hall chest); go North (→ "The door
 *            unlocks." + move to Vault, state.unlocked=true persisted);
 *            nextPlayer (single-PC wrap → endRound → round 1).
 *   Round 1: startTurn; go South (unlocked → script returns undefined →
 *            passMessage "You pass through." + move back to Hall).
 *
 * Writes:
 *   - keyed-exit.start.snapshot.json   (serialized genesis state, pre-command)
 *   - keyed-exit.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - keyed-exit.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Seeded RNG: a single shared mulberry32(SEED) — no draws actually occur in
 * this stream (healthy PC, no formations registered, lit rooms), so any seed
 * yields the same golden; coverage is asserted with hard throws below.
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "go", "dir": "north"|"south" }
 *   { "kind": "take", "targetId": "<ITEM id>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { ExitBehavior } from "wickedways/lib/exit";
import type { ICharacter } from "wickedways/lib/character/character";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Keys ─────────────────────────────────────────────────────────────────────

/** The exit-behavior registry key (mirrors Rust `exit_behavior` match arm). */
const DOOR_BEHAVIOR_KEY = "conformance:keyed-door";
/** The item behaviorKey that unlocks the door (mirrors Rust `conformance::DOOR_KEY`). */
const KEY_ITEM_KEY = "brass-key";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [KEY_ITEM_KEY]: ["key", "brass key"],
};

// ─── TS shadow of the Rust `conformance:keyed-door` ExitBehavior ──────────────
//
// MUST match crates/wickedways-core/src/world/exits.rs (conformance::KeyedDoor)
// byte-for-byte: unlock-once semantics and exact message strings.

/** TS mirror of Rust `CharacterView::has_item(DOOR_KEY)`: behaviorKey match over inventory items. */
const hasBrassKey = (character: ICharacter): boolean =>
  character.inventory.items.some((i) => i.behaviorKey === KEY_ITEM_KEY);

const keyedDoorShadow: ExitBehavior = {
  preconditions: [
    (character, state) =>
      (state as { unlocked?: boolean }).unlocked === true || hasBrassKey(character),
  ],
  script: (character, state) => {
    const s = state as { unlocked?: boolean };
    if (s.unlocked !== true && hasBrassKey(character)) {
      s.unlocked = true;
      return "The door unlocks.";
    }
    return undefined;
  },
  passMessage: "You pass through.",
  failMessage: "The door is locked.",
};

// ─── Item factory ─────────────────────────────────────────────────────────────

const noop = () => {};

/** The brass key: a plain, inert carryable Item (NOT a Key item — key items
 *  carry no behaviorKey on either side, so the door matches Item.behaviorKey). */
function makeBrassKey(): Item {
  return new Item({
    descriptor: {
      behaviorKey: KEY_ITEM_KEY,
      name: "Brass Key",
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

function buildKeyedExitRegistry() {
  return defineRegistry({
    items: {
      [KEY_ITEM_KEY]: makeBrassKey,
    },
    exits: {
      [DOOR_BEHAVIOR_KEY]: keyedDoorShadow,
    },
  });
}

// ─── Catalog exporter (verbatim from items-actions.gen.test.ts) ───────────────

/**
 * Builds the catalog entry for one item in the Rust ItemDescriptor JSON shape.
 * All four inert fields (recipe, teaches, immunities, grantsImmunity) are always
 * emitted so Rust deserialization does not fail on missing required fields.
 */
function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    // type and slot must be lowercase strings — TS ItemType values are already lowercase
    type: item.type as string,
    stat: item.stat as string,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      // droppable: omit when absent (Rust skips_serializing_if = None)
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    // Optional descriptor fields — emit only when present
    ...(item.slot !== undefined ? { slot: item.slot as string } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    // ── Inert fields — REQUIRED in the Rust ItemDescriptor; always emit ──
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

/**
 * Instantiates every registered item factory and serializes to the Rust Catalog shape.
 * Returns { items: { behaviorKey: descriptor }, aliases: { behaviorKey: [...] } }.
 */
function buildCatalog(
  registry: ReturnType<typeof buildKeyedExitRegistry>,
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

// ─── ViewModel projection helper (verbatim from items-actions.gen.test.ts) ────

/**
 * Project the full TS ViewModel to the exact Rust ViewModel subset.
 *
 * Remove:
 *   - top-level `exits` and `lockedDoors`
 *   - `status.locationName`
 *   - `room.image`
 *
 * `defeated` is kept (Rust emits it on occupant/character entities). The live
 * session-managed `opened` set is passed through to view() per step.
 */
function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]>,
  opened: ReadonlySet<string>,
) {
  const full = view(campaign, aliases, opened);

  // Project room: remove image
  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };

  // Project status: remove locationName
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

/**
 * Rooms:
 *   - Hall  (lit, start room) — holds "chest" with the brass key.
 *   - Vault (lit)             — behind the keyed North door.
 * ONE authored exit (Hall –North→ Vault) with the keyed-door behavior; the
 * assembler auto-reverses it, so Vault's South exit is the SAME Exit object
 * (shared persisted state — proves the unlocked flag survives the return trip).
 * Player: Ada (single PC). maxRounds 10 (headroom); baseEncounterChance 0 and
 * no formations → no rng draws on movement.
 */
function buildKeyedExitCampaign(rng: () => number) {
  const registry = buildKeyedExitRegistry();

  const template = authorTemplate("Keyed Exit (conformance)", registry, {
    rng,
    maxRounds: 10,
    baseEncounterChance: 0,
    now: () => 0,
  })
    .archetype({
      id: "delver",
      name: "Delver",
      baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 10 },
    })
    .room("Hall", { description: "A stone hall." })
    .room("Vault", { description: "The vault." })
    .startRoom("Hall")
    .exit("Hall", Directions.North, "Vault", {
      behaviorKey: DOOR_BEHAVIOR_KEY,
      initialState: { unlocked: false },
    })
    .loot("chest", {
      room: "Hall",
      items: [KEY_ITEM_KEY],
      description: "A small chest.",
    });

  const campaign = startSession(template, {
    players: [{ name: "Ada", archetype: "delver" }],
    gm: 0,
  });

  return { campaign, registry };
}

// ─── Command types ─────────────────────────────────────────────────────────────
//
// Each stored command serializes to exactly the Rust `Command` shape.

type Command =
  | { kind: "startTurn" }
  | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
  | { kind: "take"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate keyed-exit golden", () => {
  it("writes the keyed-exit snapshot, catalog, and golden", () => {
    // Fixed seed: this stream draws NO rng (no formations, healthy PC, lit
    // rooms), so any seed yields the same golden. Coverage is asserted below
    // with hard throws instead of a seed search.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign, registry } = buildKeyedExitCampaign(rng);

    // ── Resolve live ids ─────────────────────────────────────────────────────
    const hall = campaign.activeCharacter.currentRoom!;
    if (hall.name !== "Hall") {
      throw new Error(`Expected PC to start in "Hall", got "${hall.name}"`);
    }
    const HALL_ID = hall.id as unknown as string;

    const northExit = hall.exits.get(Directions.North);
    if (!northExit) throw new Error("Hall has no North exit.");
    const vault = northExit.otherSide(hall);
    if (vault.name !== "Vault") {
      throw new Error(`North exit should reach "Vault", got "${vault.name}"`);
    }
    const VAULT_ID = vault.id as unknown as string;

    // The auto-reversed South exit from the Vault must be the SAME Exit object
    // (shared persisted state).
    if (vault.exits.get(Directions.South) !== northExit) {
      throw new Error("Vault's South exit is not the same Exit object as Hall's North exit.");
    }

    const chest = [...hall.loot.values()][0];
    if (!chest) throw new Error("Hall chest not found.");
    const keyItem = chest.contents.find((i) => i.behaviorKey === KEY_ITEM_KEY);
    if (!keyItem) throw new Error("Brass key not found in the Hall chest.");
    const KEY_ID = keyItem.id as unknown as string;

    // ── Genesis snapshot (pre-command state) ─────────────────────────────────
    // Deep-copy: Exit[SERIALIZE] returns `state` by live reference, and this
    // snapshot is written to disk AFTER the command stream unlocks the door.
    const start = JSON.parse(
      JSON.stringify(serializeCampaign(campaign)),
    ) as ReturnType<typeof serializeCampaign>;
    const startExit = start.exits.find((e) => e.behaviorKey === DOOR_BEHAVIOR_KEY);
    if (!startExit) {
      throw new Error("Start snapshot carries no exit with the keyed-door behaviorKey.");
    }
    if (startExit.state["unlocked"] !== false) {
      throw new Error(
        `Start snapshot exit state should be {unlocked:false}, got ${JSON.stringify(startExit.state)}`,
      );
    }

    // ── Build the catalog ────────────────────────────────────────────────────
    const catalog = buildCatalog(registry, [KEY_ITEM_KEY], ALIASES);
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

    // ── Cue capture (drain buffer) ───────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── `opened` set mirroring GameSession (Take auto-adds the container) ────
    const opened = new Set<string>();

    // ── The deterministic command stream ─────────────────────────────────────
    //
    // Budgeted: take (1) + successful go (1 each); the locked go does NOT tick
    // the budget (blocked before move). Budget is 3/round — round 0 uses 2, so
    // no auto-end. nextPlayer on the single-PC party wraps → endRound → round 1.
    const commands: Command[] = [
      // Round 0, Ada
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North }, // NO key → "The door is locked.", no move
      { kind: "take", targetId: KEY_ID },    // budgeted — brass key into inventory
      { kind: "go", dir: Directions.North }, // key held → "The door unlocks." + move to Vault
      { kind: "nextPlayer" },                // single-PC wrap → endRound → round 1

      // Round 1, Ada
      { kind: "startTurn" },
      { kind: "go", dir: Directions.South }, // unlocked → "You pass through." + move to Hall
    ];

    // ── Drive the engine directly, capturing per-step state ──────────────────
    const pcNow = () => campaign.activeCharacter;

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
        case "go":
          pcNow().go(cmd.dir);
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
      }
      // Deep-copy at capture time: Exit[SERIALIZE] returns `state` by live
      // reference, so without a copy the step-3 unlock would retroactively
      // mutate the exit state recorded in earlier steps' snapshots.
      return {
        command: cmd,
        cues: drain(),
        snapshot: JSON.parse(
          JSON.stringify(serializeCampaign(campaign)),
        ) as ReturnType<typeof serializeCampaign>,
        view: JSON.parse(
          JSON.stringify(viewProjected(campaign, ALIASES, opened)),
        ) as ReturnType<typeof viewProjected>,
      };
    });

    // ── Self-validation (hard throws — the stream is deterministic) ──────────

    const mechanicTexts = (step: (typeof steps)[number]): string[] =>
      step.cues
        .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
        .map((c) => c.cue.text ?? "");

    const expectMechanicTexts = (i: number, want: string[]) => {
      const got = mechanicTexts(steps[i]!);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(
          `Step ${i} mechanic cues mismatch: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
        );
      }
    };

    const adaRoomAt = (i: number): string | null => {
      const c = steps[i]!.snapshot.characters.find((x) => x.name === "Ada");
      if (!c) throw new Error(`Ada missing from step ${i} snapshot.`);
      return c.currentRoomId;
    };

    const unlockedAt = (i: number): unknown => {
      const e = steps[i]!.snapshot.exits.find((x) => x.behaviorKey === DOOR_BEHAVIOR_KEY);
      if (!e) throw new Error(`Keyed exit missing from step ${i} snapshot.`);
      return e.state["unlocked"];
    };

    // (a) Locked attempt: fail cue, no move, state untouched.
    expectMechanicTexts(1, ["The door is locked."]);
    if (adaRoomAt(1) !== HALL_ID) {
      throw new Error(`Step 1: Ada should still be in the Hall, got room ${adaRoomAt(1)}`);
    }
    if (unlockedAt(1) !== false) {
      throw new Error(`Step 1: exit should still be locked, got unlocked=${String(unlockedAt(1))}`);
    }

    // (b) The key is in inventory after the take.
    const keyHeld = (steps[2]!.view.inventory.items as Array<{ name?: unknown }>).some(
      (i) => i.name === "Brass Key",
    );
    if (!keyHeld) throw new Error("Step 2: taken Brass Key never appeared in inventory.");

    // (c) Unlock traversal: unlock cue, PC in the Vault, unlocked persisted.
    expectMechanicTexts(3, ["The door unlocks."]);
    if (adaRoomAt(3) !== VAULT_ID) {
      throw new Error(`Step 3: Ada should be in the Vault, got room ${adaRoomAt(3)}`);
    }
    if (unlockedAt(3) !== true) {
      throw new Error(`Step 3: exit should be unlocked, got unlocked=${String(unlockedAt(3))}`);
    }

    // (d) Return trip through the now-unlocked door: script returns undefined
    //     once unlocked → passMessage; PC back in the Hall; flag still true.
    expectMechanicTexts(6, ["You pass through."]);
    if (adaRoomAt(6) !== HALL_ID) {
      throw new Error(`Step 6: Ada should be back in the Hall, got room ${adaRoomAt(6)}`);
    }
    if (unlockedAt(6) !== true) {
      throw new Error(`Step 6: exit should stay unlocked, got unlocked=${String(unlockedAt(6))}`);
    }

    // ── Write files ──────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "keyed-exit.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "keyed-exit.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "keyed-exit.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ────────────────────────────────────────────────────────
    console.log(
      `[keyed-exit] key=${KEY_ID} hall=${HALL_ID} vault=${VAULT_ID} steps=${steps.length}`,
    );
  });
});
