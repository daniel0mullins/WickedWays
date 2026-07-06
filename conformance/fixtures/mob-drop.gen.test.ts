/**
 * Mob drop-on-defeat golden generator — run once to write the committed fixture files.
 *
 * Proves the `onKnockOut` drop contract (`mob.ts:174-216` ↔ Rust
 * `combat.rs on_knock_out`) across BOTH origin branches:
 *
 *   - Ghoul  (origin "room",     authored via mobs list with room: "Crypt"):
 *     carries an EQUIPPED Iron Dagger (drop#0) + a Crypt Key (drop#1). On KO
 *     its `mob:Ghoul:remains` box receives BOTH — the dagger with its
 *     `equipped` flag still true (TS performs NO unequip on drop; the mob's
 *     equipment record keeps referencing the dropped item), and the key
 *     because `keys = origin === "room" ? [...inventory.keys] : []`.
 *   - Wraith (origin "campaign"): carries a Bone Relic (drop#0) + a Crypt Key
 *     (drop#1). On KO its `mob:Wraith:remains` box receives ONLY the relic;
 *     the key stays in the Wraith's keyring (items always drop; only keys are
 *     origin-gated).
 *
 * AUTHORING SEAMS (not expressible through the template/assembler surface):
 *   - Mob origin: the assembler always seats authored mobs via `placeMob`,
 *     which stamps origin "room". The Wraith's origin is flipped to
 *     "campaign" post-assembly through the engine-internal `SET_ORIGIN`
 *     symbol seam (the same seam campaign spawns use), BEFORE the genesis
 *     snapshot is serialized — so the start snapshot carries origin
 *     "campaign" natively and the Rust replay hydrates it as data.
 *   - Mob equipment: `drops` are loaded via `receiveItem` (never equipped),
 *     so the Ghoul's dagger is equipped post-assembly with the ordinary
 *     `equip` API (free action: no budget tick, no history, no cue, no rng
 *     for a healthy mob), again BEFORE the genesis snapshot.
 *
 * Seeded RNG is CRITICAL: all rolls draw from a SINGLE shared
 * `mulberry32(SEED)` instance — mirroring the Rust World's single `pub rng: Rng`
 * seeded once via `replay_commands(.., seed)`. NO encounter formation is
 * registered (a formation would make the setup `pc.move` seating consume a
 * spawn threshold-roll draw before the genesis snapshot, offsetting the
 * value-dependent combat rng stream).
 *
 * The start snapshot is serialized AFTER items are equipped and the origin is
 * flipped but BEFORE the first command. No rng is drawn during setup (no
 * afflictions at boot; no formations; baseEncounterChance 0).
 *
 * Damage per dagger attack (no armor on either mob):
 *   attackStrength = 3 (dagger modifier); armorSum = 0
 *   mitigator = target Sanity (Health mitigated by Sanity) = 4
 *   damageMultiplier = max(0, 10 - 4) * 0.2 = 1.2  →  damage = 3.6 per hit
 *   Hit 1: 4 → 0.4;  Hit 2: 0.4 → 0 (KO)  — 2 attacks per mob.
 *
 * Writes:
 *   - mob-drop.start.snapshot.json   (serialized genesis state, pre-command)
 *   - mob-drop.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - mob-drop.golden.json           ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum (#[serde(tag="kind",
 * rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "attack", "targetId": "<CharacterId>" }
 *   { "kind": "go",     "dir": "<Direction>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { structuralClone } from "./gen-helpers.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import type { IMob } from "wickedways/lib/character/mob";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType, createKey, SET_ORIGIN } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

/** Dagger: weapon, Health+3, maxDurability 5 (Ada's weapon AND the Ghoul's equipped drop). */
const DAGGER_KEY = "items/dagger";

/** Bone Relic: accessory, Sanity+1, no durability — the Wraith's drop item. */
const RELIC_KEY = "items/bone-relic";

/** Crypt Key: a true key item (type "key", no behaviorKey on serialization). */
const CRYPT_KEY_KEY = "items/crypt-key";

// ─── Aliases for the catalog ──────────────────────────────────────────────────
// The crypt key is NOT in the catalog: key items serialize standalone
// (kind:"key") and resolve without a catalog entry on both sides.

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

/** Crypt key: a real key item (goes to the keyring compartment via receiveItem). */
function makeCryptKey(): Item {
  return createKey({ name: "Crypt Key", keyCode: "crypt", consumeOnUse: false });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildItemRegistry() {
  return defineRegistry({
    items: {
      [DAGGER_KEY]: makeDagger,
      [RELIC_KEY]: makeRelic,
      [CRYPT_KEY_KEY]: makeCryptKey,
    },
  });
}

// ─── Catalog exporter (verbatim from mob-defeat.gen.test.ts) ──────────────────

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

// ─── ViewModel projection helper (verbatim from mob-defeat.gen.test.ts) ───────

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

// ─── Fixed ids (assembler conventions: mob = mob:<name>, drops = <mobId>:drop#i) ─

const GHOUL_ID = "mob:Ghoul";
const WRAITH_ID = "mob:Wraith";
const GHOUL_REMAINS_ID = "mob:Ghoul:remains";
const WRAITH_REMAINS_ID = "mob:Wraith:remains";
const GHOUL_DAGGER_ID = "mob:Ghoul:drop#0"; // equipped pre-snapshot
const GHOUL_KEY_ID = "mob:Ghoul:drop#1"; //   room-origin → drops
const WRAITH_RELIC_ID = "mob:Wraith:drop#0"; // always drops
const WRAITH_KEY_ID = "mob:Wraith:drop#1"; //  campaign-origin → retained

// ─── Bespoke campaign builder ─────────────────────────────────────────────────
//
// Hall (start, lit) → North → Crypt (lit, holds Ghoul + Wraith).
// Player: Ada (health=10, sanity=10, energy=10), Iron Dagger equipped.
// Ghoul  (room-origin):     stats 4/4/4, materialDrops {item:2},
//                           drops [dagger (equipped post-assembly), crypt key].
// Wraith (campaign-origin): stats 4/4/4, NO materialDrops (exercises the
//                           empty-materials skip branch), drops [relic, crypt key].
//
// NO formations registered: keeps the setup `pc.move` free of spawn
// threshold-roll draws so the genesis snapshot sees a pristine rng stream.

function buildMobDropCampaign(rng: () => number) {
  const registry = buildItemRegistry();

  const template = authorTemplate("Mob Drop (conformance)", registry, {
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
      materialDrops: { item: 2 },
      drops: [DAGGER_KEY, CRYPT_KEY_KEY],
    })
    .mob("Wraith", {
      stats: {
        [StatType.Health]: 4,
        [StatType.Sanity]: 4,
        [StatType.Energy]: 4,
      },
      room: "Crypt",
      drops: [RELIC_KEY, CRYPT_KEY_KEY],
    });

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;
  const crypt = rooms.get("Crypt")!;

  // ── Post-assembly seams (see file header) ─────────────────────────────────
  const ghoul = crypt.occupants.find((o) => (o.id as unknown as string) === GHOUL_ID) as
    | IMob
    | undefined;
  const wraith = crypt.occupants.find((o) => (o.id as unknown as string) === WRAITH_ID) as
    | IMob
    | undefined;
  if (!ghoul || !wraith) throw new Error("Ghoul/Wraith not seated in the Crypt.");

  // Flip the Wraith to campaign origin (assembler stamps "room" via placeMob).
  wraith[SET_ORIGIN]("campaign");

  // Equip the Ghoul's dagger drop (drops load via receiveItem, never equipped).
  // Free action: healthy mob → gate passes without an rng draw; no history/cue.
  const ghoulDagger = ghoul.inventory.items.find(
    (i) => (i.id as unknown as string) === GHOUL_DAGGER_ID,
  );
  if (!ghoulDagger) throw new Error("Ghoul's dagger drop not found in its inventory.");
  ghoul.equip(ghoulDagger, EquipmentSlot.LeftHand);
  if (ghoulDagger.properties.equipped !== true) {
    throw new Error("Ghoul's dagger failed to equip during setup.");
  }

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
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate mob-drop golden", () => {
  it("writes the mob-drop snapshot, catalog, and golden", () => {
    // Brute-force search for the first seed 1..500 satisfying all coverage
    // assertions (structural parity with mob-defeat.gen.test.ts; the drop
    // contract itself is rng-independent and hard-throws below).
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
      const { campaign, registry, rooms, ada } = buildMobDropCampaign(rng);

      // ── Equip Ada's dagger ─────────────────────────────────────────────────
      // Equipped during setup (no afflictions → gate allows; no rng drawn).
      const daggerItem = registry.item(DAGGER_KEY)();
      daggerItem.id = `player:Ada:item#${DAGGER_KEY}` as ItemId;
      ada.addToInventory(daggerItem);
      ada.equip(daggerItem, EquipmentSlot.LeftHand);

      // ── Genesis snapshot (pre-command; equips + origin flip already applied) ─
      const start = structuralClone(serializeCampaign(campaign));

      // ── Start-snapshot self-validation (hard throws — seed-independent) ────
      {
        const ch = (id: string) => {
          const c = start.characters.find((x) => x.id === id);
          if (!c) throw new Error(`Start snapshot: character ${id} missing.`);
          return c;
        };
        const ghoul = ch(GHOUL_ID);
        if (ghoul.origin !== "room") {
          throw new Error(`Start snapshot: Ghoul origin should be "room", got ${String(ghoul.origin)}`);
        }
        if (!Object.values(ghoul.equipment).includes(GHOUL_DAGGER_ID)) {
          throw new Error("Start snapshot: Ghoul's dagger is not equipped.");
        }
        if (!ghoul.inventory.itemIds.includes(GHOUL_DAGGER_ID)) {
          throw new Error("Start snapshot: Ghoul's dagger missing from its inventory.");
        }
        if (!ghoul.inventory.keyIds.includes(GHOUL_KEY_ID)) {
          throw new Error("Start snapshot: Ghoul's crypt key missing from its keyring.");
        }
        const wraith = ch(WRAITH_ID);
        if (wraith.origin !== "campaign") {
          throw new Error(`Start snapshot: Wraith origin should be "campaign", got ${String(wraith.origin)}`);
        }
        if (!wraith.inventory.itemIds.includes(WRAITH_RELIC_ID)) {
          throw new Error("Start snapshot: Wraith's relic missing from its inventory.");
        }
        if (!wraith.inventory.keyIds.includes(WRAITH_KEY_ID)) {
          throw new Error("Start snapshot: Wraith's crypt key missing from its keyring.");
        }
        const keyKinds = start.items.filter((i) => i.kind === "key").map((i) => i.id);
        for (const id of [GHOUL_KEY_ID, WRAITH_KEY_ID]) {
          if (!keyKinds.includes(id)) {
            throw new Error(`Start snapshot: key item ${id} not serialized as kind "key".`);
          }
        }
      }

      // ── Build catalog (keys excluded: kind:"key" items need no catalog entry) ─
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

      // ── `opened` set (no loot is ever opened in this stream) ──────────────
      const opened = new Set<string>();

      // ── The command stream ─────────────────────────────────────────────────
      //
      // Round 0, Ada's turn (budget 3):
      //   startTurn
      //   go(North)      → enters Crypt → encounter cues for BOTH mobs [budget 1]
      //   attack(Ghoul)  → hit 1 (health 4 → 0.4)                     [budget 2]
      //   attack(Ghoul)  → hit 2 → KO → materials deposit + remains
      //                    (dagger STILL equipped + crypt key)        [budget 3 → endTurn]
      //   nextPlayer     → single-PC wrap → round 1
      // Round 1, Ada's turn:
      //   startTurn
      //   attack(Wraith) → hit 1 (health 4 → 0.4)                     [budget 1]
      //   attack(Wraith) → hit 2 → KO → remains (relic ONLY; key
      //                    retained — campaign origin)                [budget 2]
      const commands: Command[] = [
        { kind: "startTurn" },
        { kind: "go", dir: Directions.North },
        { kind: "attack", targetId: GHOUL_ID },
        { kind: "attack", targetId: GHOUL_ID },
        { kind: "nextPlayer" },
        { kind: "startTurn" },
        { kind: "attack", targetId: WRAITH_ID },
        { kind: "attack", targetId: WRAITH_ID },
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
              encounteredError = true;
              break;
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

      if (encounteredError) continue;

      // ── Coverage checks (seed-search parity with mob-defeat) ───────────────

      // (a) Encounter cues fired for the mobs.
      if (!steps.some((s) => s.cues.some((c) => c.kind === "encounter"))) continue;

      // (b) A mob codex record + a material codex record exist.
      const anyCodex = (kind: string) =>
        steps.some((s) =>
          (s.snapshot.codex ?? []).some(
            (e) => (e as { kind: string }).kind === kind,
          ),
        );
      if (!anyCodex("mob")) continue;
      if (!anyCodex("material")) continue;

      // (c) campaign.materials gained the Ghoul's deposit.
      if (
        !steps.some(
          (s) => ((s.snapshot.campaign.materials as Record<string, number>)?.["item"] ?? 0) > 0,
        )
      ) continue;

      // (d) Both mobs show defeated in the final view.
      const lastView = steps[steps.length - 1]!.view;
      const defeatedCount = (lastView.occupants as Array<{ defeated?: boolean }>).filter(
        (o) => o.defeated === true,
      ).length;
      if (defeatedCount !== 2) continue;

      // ── Drop-contract self-validation (hard throws — rng-independent) ──────
      const lastSnapshot = steps[steps.length - 1]!.snapshot;
      const lootBox = (id: string) => {
        const l = lastSnapshot.loot.find((x) => (x.id as unknown as string) === id);
        if (!l) throw new Error(`Final snapshot: loot box ${id} missing.`);
        return l;
      };
      const charOf = (id: string) => {
        const c = lastSnapshot.characters.find((x) => x.id === id);
        if (!c) throw new Error(`Final snapshot: character ${id} missing.`);
        return c;
      };

      // (1) Room-origin remains: equipped dagger AND key both dropped.
      const ghoulRemains = lootBox(GHOUL_REMAINS_ID);
      if (!ghoulRemains.contentIds.includes(GHOUL_DAGGER_ID)) {
        throw new Error("Ghoul remains missing the (equipped) dagger drop.");
      }
      if (!ghoulRemains.contentIds.includes(GHOUL_KEY_ID)) {
        throw new Error("Ghoul remains missing the crypt key (room-origin mobs drop keys).");
      }

      // (2) NO unequip on drop: the LIVE dropped dagger still carries
      //     equipped:true, and the Ghoul's equipment record still references it.
      const crypt = rooms.get("Crypt")!;
      const liveRemains = [...crypt.loot.values()].find(
        (l) => (l.id as unknown as string) === GHOUL_REMAINS_ID,
      );
      if (!liveRemains) throw new Error("Live Ghoul remains box missing from the Crypt.");
      const liveDagger = liveRemains.contents.find(
        (i) => (i.id as unknown as string) === GHOUL_DAGGER_ID,
      );
      if (!liveDagger) throw new Error("Live Ghoul remains box missing the dagger.");
      if (liveDagger.properties.equipped !== true) {
        throw new Error(
          "Dropped dagger should STILL be flagged equipped:true (TS performs no unequip on drop).",
        );
      }
      const ghoulAfter = charOf(GHOUL_ID);
      if (!Object.values(ghoulAfter.equipment).includes(GHOUL_DAGGER_ID)) {
        throw new Error(
          "Ghoul's equipment record should still reference the dropped dagger (no unequip on drop).",
        );
      }
      if (ghoulAfter.inventory.itemIds.length !== 0 || ghoulAfter.inventory.keyIds.length !== 0) {
        throw new Error("Ghoul's inventory should be fully relinquished after the drop.");
      }

      // (3) Campaign-origin remains: relic dropped, key NOT dropped (retained).
      const wraithRemains = lootBox(WRAITH_REMAINS_ID);
      if (!wraithRemains.contentIds.includes(WRAITH_RELIC_ID)) {
        throw new Error("Wraith remains missing the relic drop (items always drop).");
      }
      if (wraithRemains.contentIds.includes(WRAITH_KEY_ID)) {
        throw new Error(
          "Wraith remains must NOT contain the crypt key (keys are gated to room-origin mobs).",
        );
      }
      const wraithAfter = charOf(WRAITH_ID);
      if (!wraithAfter.inventory.keyIds.includes(WRAITH_KEY_ID)) {
        throw new Error("Wraith should retain its crypt key in the keyring (campaign origin).");
      }
      if (wraithAfter.inventory.itemIds.length !== 0) {
        throw new Error("Wraith's non-key items should be fully relinquished after the drop.");
      }

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
      join(here, "mob-drop.start.snapshot.json"),
      JSON.stringify(goldenStart, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mob-drop.catalog.json"),
      JSON.stringify(goldenCatalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "mob-drop.golden.json"),
      JSON.stringify({ seed: goldenSeed, commands: goldenCommands, steps: goldenSteps }, null, 2) + "\n",
    );

    // ── Debug summary ──────────────────────────────────────────────────────
    console.log(
      `[mob-drop] SEED=${SEED} steps=${goldenSteps.length}`,
    );
  });
});
