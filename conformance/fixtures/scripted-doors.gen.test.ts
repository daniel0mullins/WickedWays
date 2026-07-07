/**
 * scripted-doors golden generator.
 *
 * TS side: the REAL Hollow House `doorBehavior` closures (content.ts:23-39)
 * registered under study-door (brass) / attic-door (iron) — the ORACLE. Rust
 * side: the same keys resolve to the scripted `ExitScript` ASTs carried in
 * catalog.behaviors (hollowHouseBehaviors()). Green = the AST + interpreter
 * reproduce the closures byte-for-byte across:
 *   - locked door, no key            → fail message, no move, no budget tick
 *   - keyed unlock                   → unlock cue + move + state.unlocked=true
 *   - silent re-pass (already open)  → moves, NO mechanic cue
 *
 * The brass key drops from a room-origin Wraith (keys drop when origin==="room";
 * mob-drop.gen.test.ts:12), taken from the remains, then used on the study door.
 * The attic door (iron) is never keyed, so it stays locked (locked coverage).
 *
 * Seeded RNG: a single shared mulberry32(SEED). The stream is deterministic —
 * the one-hit KO (3 * max(0,10-4) * 0.2 = 3.6 >= 2 health) draws no combat rng
 * (no escape roll on a lethal hit), no formations, lit rooms — so any seed
 * yields the same golden; coverage is asserted with hard throws.
 *
 * Writes scripted-doors.{start.snapshot,catalog,golden}.json. Run: pnpm run fixtures:gen.
 *
 * Interface contract with the Rust replay: each command deserializes into the
 * Rust `Command` enum (#[serde(tag="kind", rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "endTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "go", "dir": "north"|"west"|"east" }
 *   { "kind": "take", "targetId": "<ITEM id>" }
 *   { "kind": "attack", "targetId": "<CharacterId>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { structuralClone, viewProjected } from "./gen-helpers.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import type { IItem } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import { buildCatalog } from "./scripted-helpers.ts";
import { doorBehavior } from "../../packages/campaigns/src/hollow-house/content.ts";
import { brassKey } from "../../packages/campaigns/src/hollow-house/items.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";
import { ExitBehaviors, Keys, Rooms } from "../../packages/campaigns/src/hollow-house/ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x0d00;

// ─── Item behavior keys ───────────────────────────────────────────────────────
const DAGGER_KEY = "items/dagger";

// The two door messages MUST match hollowHouseBehaviors() (scripted.ts) exactly.
const STUDY_OPENED = "The brass key turns; the study door swings open.";
const ATTIC_OPENED = "The iron key grinds in the lock; the attic stairs open above you.";

const noop = () => {};

/** Iron dagger: weapon targeting Health, maxDurability 5 (Ada's weapon). */
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
// items: dagger (Ada's weapon) + brass key (the Wraith's keyring drop).
// exits: the REAL doorBehavior closures (the oracle) keyed as the engine resolves.
function buildDoorRegistry() {
  return defineRegistry({
    items: {
      [DAGGER_KEY]: makeDagger,
      [Keys.Brass]: brassKey,
    },
    exits: {
      [ExitBehaviors.StudyDoor]: doorBehavior("brass", "study door", STUDY_OPENED),
      [ExitBehaviors.AtticDoor]: doorBehavior("iron", "attic door", ATTIC_OPENED),
    },
  });
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────
//
// Landing (start) —west/study-door→ Study; —north/attic-door→ Attic; —east→
// Nursery. Both doors start { unlocked: false }. A room-origin Wraith sits in
// the Nursery carrying the brass key (drops on KO). Single PC, Ada.
function buildDoorCampaign(rng: () => number) {
  const registry = buildDoorRegistry();

  const template = authorTemplate("Scripted Doors (conformance)", registry, {
    rng,
    maxRounds: 10,
    baseEncounterChance: 0,
    now: () => 0,
  })
    .archetype({
      id: "heir",
      name: "Heir",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10,
      },
    })
    .room(Rooms.Landing, { description: "The upstairs landing." })
    .room(Rooms.Study, { description: "A book-lined study." })
    .room(Rooms.Attic, { description: "A cramped attic." })
    .room(Rooms.Nursery, { description: "A silent nursery." })
    .startRoom(Rooms.Landing)
    .exit(Rooms.Landing, Directions.West, Rooms.Study, {
      behaviorKey: ExitBehaviors.StudyDoor,
      name: "study door",
      initialState: { unlocked: false },
    })
    .exit(Rooms.Landing, Directions.North, Rooms.Attic, {
      behaviorKey: ExitBehaviors.AtticDoor,
      name: "attic door",
      initialState: { unlocked: false },
    })
    .exit(Rooms.Landing, Directions.East, Rooms.Nursery)
    .mob("Wraith", {
      stats: {
        [StatType.Health]: 2,
        [StatType.Sanity]: 4,
        [StatType.Energy]: 4,
      },
      room: Rooms.Nursery,
      drops: [Keys.Brass],
      naturalAttack: { stat: StatType.Sanity, power: 1 },
    });

  const campaign = startSession(template, {
    players: [{ name: "Ada", archetype: "heir" }],
    gm: 0,
  });

  return { campaign, registry };
}

// ─── Command types ─────────────────────────────────────────────────────────────
type Command =
  | { kind: "startTurn" }
  | { kind: "endTurn" }
  | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
  | { kind: "take"; targetId: string }
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate scripted-doors golden", () => {
  it("writes the booted snapshot + per-step golden", () => {
    const rng = mulberry32(SEED);
    const { campaign, registry } = buildDoorCampaign(rng);

    // ── Equip Ada's dagger pre-snapshot (free: healthy PC, gate allows, no rng) ─
    const pc = campaign.activeCharacter;
    const daggerItem = registry.item(DAGGER_KEY)();
    daggerItem.id = `${pc.id as unknown as string}:item#dagger` as ItemId;
    pc.addToInventory(daggerItem);
    pc.equip(daggerItem, EquipmentSlot.LeftHand);

    // ── Resolve live ids for the command stream ──────────────────────────────
    const landing = pc.currentRoom!;
    if (landing.name !== Rooms.Landing) {
      throw new Error(`Expected PC to start in "${Rooms.Landing}", got "${landing.name}"`);
    }
    const LANDING_ID = landing.id as unknown as string;

    const nurseryExit = landing.exits.get(Directions.East);
    if (!nurseryExit) throw new Error("Landing has no East (Nursery) exit.");
    const nursery = nurseryExit.otherSide(landing);
    if (nursery.name !== Rooms.Nursery) {
      throw new Error(`East exit should reach "${Rooms.Nursery}", got "${nursery.name}"`);
    }

    const wraith = [...nursery.occupants].find((o) => o.name === "Wraith");
    if (!wraith) throw new Error("Wraith not seated in the Nursery.");
    const WRAITH_ID = wraith.id as unknown as string;
    const heldBrass = wraith.inventory.keys.find((k) => k.keyCode === "brass");
    if (!heldBrass) throw new Error("Wraith is not carrying the brass key.");
    const BRASS_KEY_ID = heldBrass.id as unknown as string;

    // ── Genesis snapshot (pre-command; dagger equipped, doors locked) ─────────
    const start = structuralClone(serializeCampaign(campaign));
    for (const key of [ExitBehaviors.StudyDoor, ExitBehaviors.AtticDoor]) {
      const e = start.exits.find((x) => x.behaviorKey === key);
      if (!e) throw new Error(`Start snapshot missing exit with behaviorKey "${key}".`);
      if (e.state["unlocked"] !== false) {
        throw new Error(`Start snapshot exit "${key}" should be {unlocked:false}, got ${JSON.stringify(e.state)}`);
      }
    }

    // ── Build catalog: dagger item + the two scripted door behaviors. The brass
    //    key is a true Key (kind:"key") — it serializes standalone, no catalog
    //    entry (mob-drop.gen.test.ts:96-97). ───────────────────────────────────
    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      { [DAGGER_KEY]: makeDagger },
      [DAGGER_KEY],
      {},
      {
        [ExitBehaviors.StudyDoor]: behaviors[ExitBehaviors.StudyDoor]!,
        [ExitBehaviors.AtticDoor]: behaviors[ExitBehaviors.AtticDoor]!,
      },
    );

    // ── Cue capture ──────────────────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    const opened = new Set<string>();

    // ── The command stream (PC budget 3/round) ───────────────────────────────
    //
    // R0 Ada:
    //   startTurn
    //   go north → attic-door LOCKED  (fail cue, no move, no budget tick)
    //   go west  → study-door LOCKED  (fail cue, no move, no budget tick)
    //   go east  → Nursery [budget 1]  (encounter cue for the Wraith)
    //   attack Wraith → one-hit KO → remains(brass key) [budget 2]
    //   endTurn; nextPlayer → single-PC wrap → round 1
    // R1 Ada:
    //   startTurn
    //   take brassKey [budget 1]   (from the Wraith's remains, in the Nursery)
    //   go west → Landing [budget 2]
    //   endTurn; nextPlayer → round 2
    // R2 Ada:
    //   startTurn
    //   go west → study-door: hasKey("brass") → unlock cue + move to Study [1]
    //   go east → unlocked re-pass: SILENT (no mechanic cue) → Landing [2]
    //   endTurn; nextPlayer
    const commands: Command[] = [
      // R0
      { kind: "startTurn" },
      { kind: "go", dir: Directions.North }, // attic LOCKED
      { kind: "go", dir: Directions.West }, //  study LOCKED
      { kind: "go", dir: Directions.East }, //  → Nursery
      { kind: "attack", targetId: WRAITH_ID }, // KO → drops brass key
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R1
      { kind: "startTurn" },
      { kind: "take", targetId: BRASS_KEY_ID },
      { kind: "go", dir: Directions.West }, // Nursery → Landing
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R2
      { kind: "startTurn" },
      { kind: "go", dir: Directions.West }, // study-door unlock + move to Study
      { kind: "go", dir: Directions.East }, // unlocked re-pass → Landing (silent)
      { kind: "endTurn" },
      { kind: "nextPlayer" },
    ];

    // ── Drive the engine directly ────────────────────────────────────────────
    const pcNow = () => campaign.activeCharacter;
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
        case "endTurn":
          pcNow().endTurn();
          break;
        case "nextPlayer":
          campaign.nextPlayer();
          break;
        case "go":
          pcNow().go(cmd.dir);
          break;
        case "take": {
          const { loot, item } = findInLoot(cmd.targetId);
          if (!opened.has(loot.id)) {
            pcNow().openLootBox(loot);
            opened.add(loot.id);
          }
          pcNow().takeFromLootBox(loot, [item]);
          break;
        }
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
      // Deep-copy at capture time: Exit[SERIALIZE] returns `state` by live
      // reference, so a later unlock would retroactively mutate earlier snapshots.
      return {
        command: cmd,
        cues: drain(),
        snapshot: structuralClone(serializeCampaign(campaign)),
        view: structuralClone(viewProjected(campaign, {}, opened)),
      };
    });

    // ── Self-checks: the fixture must exercise the gate coverage ─────────────
    const mechanicTexts = (i: number): string[] =>
      steps[i]!.cues
        .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
        .map((c) => c.cue.text ?? "");

    const allMechanicTexts = steps.flatMap((_, i) => mechanicTexts(i));
    const countOf = (t: string) => allMechanicTexts.filter((x) => x === t).length;

    const atticFail = "The attic door won't budge — it's locked.";
    const studyFail = "The study door won't budge — it's locked.";
    if (countOf(atticFail) !== 1) throw new Error(`expected exactly 1 attic fail cue, got ${countOf(atticFail)}`);
    if (countOf(studyFail) !== 1) throw new Error(`expected exactly 1 study fail cue, got ${countOf(studyFail)}`);
    if (countOf(STUDY_OPENED) !== 1) throw new Error(`expected exactly 1 study unlock cue, got ${countOf(STUDY_OPENED)}`);

    // The final go-east (step 14) must be a SILENT unlocked re-pass: no mechanic cue.
    if (mechanicTexts(14).length !== 0) {
      throw new Error(`silent re-pass step must carry no mechanic cue, got ${JSON.stringify(mechanicTexts(14))}`);
    }

    // Ada ends in the Landing.
    const adaRoomAt = (i: number): string | null => {
      const c = steps[i]!.snapshot.characters.find((x) => x.name === "Ada");
      if (!c) throw new Error(`Ada missing from step ${i} snapshot.`);
      return c.currentRoomId;
    };
    const lastIdx = steps.length - 1;
    if (adaRoomAt(lastIdx) !== LANDING_ID) {
      throw new Error(`Ada should end in the Landing, got room ${adaRoomAt(lastIdx)}`);
    }

    // The study door persisted unlocked=true after the unlock (step 13 onward).
    const studyUnlockedAt = (i: number): unknown => {
      const e = steps[i]!.snapshot.exits.find((x) => x.behaviorKey === ExitBehaviors.StudyDoor);
      if (!e) throw new Error(`Study door missing from step ${i} snapshot.`);
      return e.state["unlocked"];
    };
    if (studyUnlockedAt(13) !== true) {
      throw new Error(`Step 13: study door should be unlocked, got ${String(studyUnlockedAt(13))}`);
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
    writeFileSync(join(here, "scripted-doors.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");
    writeFileSync(join(here, "scripted-doors.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(here, "scripted-doors.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");

    console.log(`[scripted-doors] wraith=${WRAITH_ID} brassKey=${BRASS_KEY_ID} steps=${steps.length}`);
  });
});
