/**
 * caretaker golden — the COMPOSED Hollow-House caretaker differential fixture
 * (NPC sub-plan 4). It threads the whole caretaker beat through the authoritative
 * gate, byte-identical Rust core <-> TS oracle:
 *   • the Foyer start-room enter-scene (`caretaker-intro`) surfacing its cue at
 *     `begin_campaign` (lands in startupCues),
 *   • an `examine` of the visible caretaker -> his description cue,
 *   • a LOCKED move South (no key yet) -> the door fail cue, PC stays in the Foyer,
 *   • a `talk` hand-off -> response cue FIRST, then the `giveItem`(cellar key) +
 *     `setVisible(false)` effects + the `once` npcState latch,
 *   • a re-`examine` of the now-invisible caretaker -> quiet no-op (visible filter),
 *   • an UNLOCK move South (now holding the key) -> the door opened cue, PC in Cellar.
 *
 * DUAL ENCODING (the whole point): the caretaker + door are each authored TWICE
 * for the SAME key — the REAL authored content is imported from the campaign:
 *   • DSL twins in `catalog.behaviors` (`caretakerScript` / `caretakerIntroScene` /
 *     `doorScript`) — the Rust core interprets these, and they are ALSO what the
 *     oracle's talk/examine resolve via `behaviors[key]` + npc-matcher, and
 *   • native shadows in the REGISTRY (a legacy `NpcBehavior`, a `doorBehavior`
 *     `ExitBehavior`, a cue-only `SceneBehavior`) — used by `assemble`/`go`/scene
 *     firing to seat the NPC, build the native door, and attach the scene.
 * The caretaker's held-key literals baked into `caretakerScript`
 * (`npc:Caretaker` + `npc:Caretaker:item#0`) match the ids the assembler mints for
 * an NPC named "Caretaker" holding one item, so the hand-off resolves on both sides.
 *
 * We hand-build a MINIMAL Foyer+Cellar world (no dread/storyteller/formations) so
 * the golden carries no incidental rng draws or status cues — only the caretaker
 * beat is under test. The full campaign's reverse traversal is the capstone's job.
 *
 * Writes caretaker.{genesis,catalog,golden}.json. Run via: pnpm run fixtures:gen
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { SceneBehavior } from "wickedways/lib/serialization/registry";
import type { MechanicCue } from "wickedways/lib/mechanics/mechanic";
import { mulberry32 } from "../seeded-rng.ts";
import { itemToCatalogEntry } from "./facade-catalog.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";
import {
  caretakerScript,
  caretakerIntroScene,
  doorScript,
  CARETAKER_DESCRIPTION,
  CARETAKER_HANDOFF,
  CARETAKER_INTRO_CUE,
} from "../../packages/campaigns/src/hollow-house/scripted.ts";
import { doorBehavior } from "../../packages/campaigns/src/hollow-house/content.ts";
import { cellarKey } from "../../packages/campaigns/src/hollow-house/items.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xca4e; // "caretaker"; no rng draws in this flow (like npc-dialogue)

// Behavior keys (arbitrary for this minimal world — the caretaker char id and its
// held-key item id are minted by the assembler from the NPC NAME, not these keys).
const CARETAKER_KEY = "caretaker";
const INTRO_KEY = "caretaker-intro";
const DOOR_KEY = "cellar-door";
const KEY_ITEM_KEY = "cellar-key";

// The assembler mints `npc:<name>` for the NPC and `npc:<name>:item#<i>` for each
// held item — matching the literals baked into the imported `caretakerScript`.
const CARETAKER_ID = "npc:Caretaker";

// The cellar-door opened line. Used in BOTH the native `doorBehavior` shadow and
// the `doorScript` DSL twin so the two engines' open cue is byte-identical (the
// door-twins byte-identity requirement). Matches the real campaign's cellar door.
const OPENED = "The cellar key turns; the cellar door swings open.";
const DOOR_FAIL = "The cellar door won't budge — it's locked.";

// The intro scene's native shadow (registry) — a cue-only enter scene, mirroring
// the imported `caretakerIntroScene` DSL twin. Fires at begin_campaign.
const introSceneShadow: SceneBehavior = {
  preconditions: [],
  script: (): MechanicCue[] => [{ text: CARETAKER_INTRO_CUE }],
};

describe("generate caretaker golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({
      items: { [KEY_ITEM_KEY]: cellarKey },
      exits: { [DOOR_KEY]: doorBehavior("cellar", "cellar door", OPENED) },
      npcs: { [CARETAKER_KEY]: { initialDialogue: CARETAKER_HANDOFF, dialogue: [] } },
      scenes: { [INTRO_KEY]: introSceneShadow },
    });

    const template = authorTemplate("Caretaker (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Foyer", { description: "The gloom of the foyer." })
      .room("Cellar", { description: "A cold stone cellar." })
      .startRoom("Foyer")
      .exit("Foyer", Directions.South, "Cellar", {
        behaviorKey: DOOR_KEY, name: "cellar door", initialState: { unlocked: false },
      })
      .npc("Caretaker", {
        stats: { [StatType.Health]: 1, [StatType.Sanity]: 1, [StatType.Energy]: 1 },
        room: "Foyer", behavior: CARETAKER_KEY, holds: [KEY_ITEM_KEY],
      })
      .scene("Foyer", INTRO_KEY, { phase: "enter" });

    const behaviors = {
      [CARETAKER_KEY]: caretakerScript,
      [INTRO_KEY]: caretakerIntroScene,
      [DOOR_KEY]: doorScript("cellar", "cellar door", OPENED),
    };
    // The catalog must carry EVERY item the description references — the Caretaker
    // holds the cellar key (`holds: [KEY_ITEM_KEY]`), so export it here (the same
    // registry factory the campaign registered under KEY_ITEM_KEY), or the Rust
    // assembler throws UnregisteredItem.
    const catalog = { items: { [KEY_ITEM_KEY]: itemToCatalogEntry(cellarKey()) }, aliases: {}, behaviors };

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng, behaviors,
    });

    const ops: FacadeOp[] = [
      { kind: "examine", targetId: CARETAKER_ID },                          // 0 description cue
      { kind: "submit", intent: { kind: "move", dir: Directions.South } },  // 1 LOCKED: fail cue, stay Foyer
      { kind: "submit", intent: { kind: "talk", npcId: CARETAKER_ID } },    // 2 hand-off: cue + key + hide
      { kind: "examine", targetId: CARETAKER_ID },                          // 3 GONE: quiet no-op
      { kind: "submit", intent: { kind: "move", dir: Directions.South } },  // 4 UNLOCK: opened cue, -> Cellar
    ];
    const steps = writeFacadeFixture(here, "caretaker", SEED, oracle, catalog, ops, template.description);

    // ── self-validation: assert the composed beat in the generated golden ─────────
    // (Serialized shape: characters carry NO room field — a room lists its
    //  `occupantIds`; keys live in `inventory.keyIds`; the held cellar key's id is
    //  the assembler-minted `npc:Caretaker:item#0`.)
    const PC_ID = "player:Ada";
    const KEY_ITEM_ID = "npc:Caretaker:item#0";
    type Cue = { kind: string; cue?: { text?: string } };
    type Submit = { error?: string; cues: Cue[] };
    type Char = { id: string; visible?: boolean; npcState?: unknown; inventory?: { keyIds?: string[] } };
    type RoomSnap = { name: string; occupantIds: string[] };
    type Snap = { characters: Char[]; rooms: RoomSnap[] };

    const mechText = (cues: Cue[]): string[] =>
      cues.filter((c) => c.kind === "mechanic").map((c) => c.cue?.text ?? "");
    const submitTexts = (i: number): string[] => mechText((steps[i]!.result as Submit).cues);
    const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const pcRoom = (snap: Snap): string | undefined =>
      snap.rooms.find((r) => r.occupantIds.includes(PC_ID))?.name;
    const caretaker = (snap: Snap): Char | undefined =>
      snap.characters.find((c) => c.id === CARETAKER_ID);

    // (0) startup: the Foyer start-room enter-scene cue surfaces at begin_campaign.
    const startTexts = mechText(oracle.startupCues as unknown as Cue[]);
    if (!startTexts.includes(CARETAKER_INTRO_CUE)) {
      throw new Error(`startup cues must contain the intro cue, got ${JSON.stringify(startTexts)}`);
    }

    // (1) examine (op 0): the caretaker is present + visible -> his description cue.
    const ex0 = steps[0]!.result as Cue[];
    if (ex0.length !== 1 || ex0[0]!.cue?.text !== CARETAKER_DESCRIPTION) {
      throw new Error(`step 0: examine must emit the caretaker description, got ${JSON.stringify(ex0)}`);
    }

    // (2) locked move (op 1): fail cue, and the PC did NOT leave the Foyer.
    if (!eq(submitTexts(1), [DOOR_FAIL])) {
      throw new Error(`step 1: locked move must emit the fail cue, got ${JSON.stringify(submitTexts(1))}`);
    }
    if (pcRoom(steps[1]!.snapshot as Snap) !== "Foyer") {
      throw new Error(`step 1: PC must stay in the Foyer, got ${String(pcRoom(steps[1]!.snapshot as Snap))}`);
    }

    // (3) talk hand-off (op 2): response cue FIRST (no effect cues from give/hide),
    //     then the caretaker is hidden, the once-latch is written, and the PC now
    //     carries the cellar key.
    if (!eq(submitTexts(2), [CARETAKER_HANDOFF])) {
      throw new Error(`step 2: hand-off must emit the response cue, got ${JSON.stringify(submitTexts(2))}`);
    }
    const snap2 = steps[2]!.snapshot as Snap;
    const care2 = caretaker(snap2);
    if (care2?.visible !== false) throw new Error("step 2: caretaker must be visible:false after the hand-off");
    if (care2.npcState === undefined) throw new Error("step 2: caretaker must have npcState (once latch) after the hand-off");
    const pc2 = snap2.characters.find((c) => c.id === PC_ID);
    if (!(pc2?.inventory?.keyIds ?? []).includes(KEY_ITEM_ID)) {
      throw new Error(`step 2: PC must hold the cellar key after the hand-off, got ${JSON.stringify(pc2?.inventory)}`);
    }

    // (4) re-examine (op 3): the caretaker is now invisible -> quiet no-op (no cues).
    const ex3 = steps[3]!.result as Cue[];
    if (ex3.length !== 0) throw new Error(`step 3: examining the vanished caretaker must be a no-op, got ${JSON.stringify(ex3)}`);

    // (5) unlock move (op 4): opened cue, PC now in the Cellar.
    if (!eq(submitTexts(4), [OPENED])) {
      throw new Error(`step 4: unlock move must emit the opened cue, got ${JSON.stringify(submitTexts(4))}`);
    }
    if (pcRoom(steps[4]!.snapshot as Snap) !== "Cellar") {
      throw new Error(`step 4: PC must have moved to the Cellar, got ${String(pcRoom(steps[4]!.snapshot as Snap))}`);
    }
  });
});
