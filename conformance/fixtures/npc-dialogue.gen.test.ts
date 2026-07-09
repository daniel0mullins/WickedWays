/**
 * npc-dialogue golden — the COMPREHENSIVE dialogue-matcher differential fixture
 * (NPC sub-plan 2, Task 4b). This is the payoff: it puts the matcher's byte-parity
 * (Rust `ScriptedNpc` core vs the TS oracle in `npc-matcher.ts`) under the
 * authoritative gate for every rule the `npc-foundation` fixture does NOT touch —
 * fuzzy scoring, exact/fuzzy precedence, TRAP #1, the vacuous catch-all, the
 * strict-`>` tie-break, the `once` latch + effect suppression + the `npcState`
 * golden byte, multi-NPC independent latches, and the per-event effect cap.
 *
 * ── The cast (all co-located, visible, in Hall) ──────────────────────────────
 *   • Warden (npc:Warden, behavior `npc/warden`) — the rich dialogue NPC. Its
 *     ordered `dialogue` array is authored so that selection is provable:
 *       idx 0  exact("open sesame")          "The passage opens."
 *       idx 1  exact("help me")              "I will help you."
 *       idx 2  fuzzy(help)          score 1  "Help is a fuzzy word."
 *       idx 3  fuzzy(how,get,out)   score 3  "Follow the north stair."
 *       idx 4  fuzzy(cellar)        score 1  "The cellar lies below."
 *       idx 5  fuzzy(door,"!!!")    score 1  "The door is heavy."     (TRAP #1)
 *       idx 6  fuzzy(key)           score 1  "A key hangs on the wall."
 *       idx 7  fuzzy(gate)          score 1  "The gate is shut."
 *       idx 8  fuzzy("!!!")         score 0  "The warden shrugs."     (vacuous)
 *       idx 9  exact("overload")    65 effects → per-event cap violation
 *     default: exact("")            "The warden watches you."
 *   • Castor + Pollux (npc:Castor / npc:Pollux) — TWO NPCs sharing behavior
 *     `npc/twin`, whose idx-0 entry is `once:true` with a benign `cue` effect
 *     ("The twins glow."). Firing one twin's latch must NOT set the other's.
 *
 * The `talk`/`examine` paths are FREE (non-advancing): the round stays 0 across
 * the whole stream, and each op is a separate command, so the `once` latch has to
 * survive the serialize→deserialize the facade replay performs between commands.
 *
 * DUAL ENCODING: the same catalog `behaviors` map drives BOTH engines — the Rust
 * core interprets it via `ScriptedNpc`, the oracle via `npc-matcher.ts`. The gate
 * proves the two matchers select the same entry, coerce the same response string,
 * build the same effects, cap identically, and latch `npcState` identically.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";
import { npc, entry, exact, fuzzy, lit, cue } from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xd1a109;

const WARDEN_KEY = "npc/warden";
const TWIN_KEY = "npc/twin";

// idx 9: an entry whose effects exceed MAX_EFFECTS_PER_EVENT (64) — 65 benign
// cues. On selection the core/oracle build all 65, then the per-event cap rejects
// the talk BEFORE the response cue is emitted (error result, no cues).
const OVERLOAD_EFFECTS = Array.from({ length: 65 }, () => cue(lit("x")));

// ── the Warden's rich dialogue (catalog.behaviors[WARDEN_KEY]) ────────────────
const wardenBehavior = npc({
  description: "A grim warden bars the way.",
  default: entry({ match: exact(""), response: lit("The warden watches you.") }),
  dialogue: [
    entry({ match: exact("open sesame"), response: lit("The passage opens.") }),        // 0
    entry({ match: exact("help me"), response: lit("I will help you.") }),              // 1
    entry({ match: fuzzy("help"), response: lit("Help is a fuzzy word.") }),            // 2
    entry({ match: fuzzy("how", "get", "out"), response: lit("Follow the north stair.") }), // 3
    entry({ match: fuzzy("cellar"), response: lit("The cellar lies below.") }),         // 4
    entry({ match: fuzzy("door", "!!!"), response: lit("The door is heavy.") }),        // 5 TRAP #1
    entry({ match: fuzzy("key"), response: lit("A key hangs on the wall.") }),          // 6
    entry({ match: fuzzy("gate"), response: lit("The gate is shut.") }),                // 7
    entry({ match: fuzzy("!!!"), response: lit("The warden shrugs.") }),                // 8 vacuous
    entry({ match: exact("overload"), response: lit("Never emitted."), effects: OVERLOAD_EFFECTS }), // 9 cap
  ],
});

// ── the shared twin dialogue (catalog.behaviors[TWIN_KEY]) ────────────────────
// idx 0 is `once:true`: its benign `cue` effect fires exactly once PER INSTANCE.
const TWIN_LINE = "A blessing upon you.";
const TWIN_GLOW = "The twins glow.";
const twinBehavior = npc({
  description: "A pair of pale twins whisper as one.",
  default: entry({ match: exact(""), response: lit("We are the twins.") }),
  dialogue: [
    entry({ match: fuzzy("bless"), response: lit(TWIN_LINE), effects: [cue(lit(TWIN_GLOW))], once: true }),
  ],
});

describe("generate npc-dialogue golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    // Legacy registry NPC entries just seat the instances; the matcher logic lives
    // in the catalog `behaviors` below (resolved by the same behaviorKey).
    const registry = defineRegistry({
      items: {},
      npcs: {
        [WARDEN_KEY]: { initialDialogue: "The warden watches you.", dialogue: [] },
        [TWIN_KEY]: { initialDialogue: "We are the twins.", dialogue: [] },
      },
    });

    const template = authorTemplate("NPC Dialogue (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .npc("Warden", {
        stats: { [StatType.Health]: 3, [StatType.Sanity]: 3, [StatType.Energy]: 3 },
        room: "Hall", behavior: WARDEN_KEY,
      })
      .npc("Castor", {
        stats: { [StatType.Health]: 3, [StatType.Sanity]: 3, [StatType.Energy]: 3 },
        room: "Hall", behavior: TWIN_KEY,
      })
      .npc("Pollux", {
        stats: { [StatType.Health]: 3, [StatType.Sanity]: 3, [StatType.Energy]: 3 },
        room: "Hall", behavior: TWIN_KEY,
      });

    const behaviors = { [WARDEN_KEY]: wardenBehavior, [TWIN_KEY]: twinBehavior };
    const catalog = { items: {}, aliases: {}, behaviors };

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng, behaviors,
    });

    // Resolve engine-assigned ids from the oracle view's occupants (by name).
    const startVm = oracle.view();
    const idOf = (name: string): string => {
      const occ = startVm.occupants.find((o) => o.name === name);
      if (occ === undefined) throw new Error(`expected ${name} in view.occupants at start`);
      return occ.id;
    };
    const wardenId = idOf("Warden");
    const castorId = idOf("Castor");
    const polluxId = idOf("Pollux");

    const talk = (npcId: string, prompt?: string): FacadeOp =>
      ({ kind: "submit", intent: prompt === undefined ? { kind: "talk", npcId } : { kind: "talk", npcId, prompt } });

    const ops: FacadeOp[] = [
      { kind: "examine", targetId: wardenId },              //  0 examine → description        [#1]
      talk(wardenId),                                       //  1 bare → default               [#2]
      talk(wardenId, "open sesame"),                        //  2 exact idx0                    [#3a]
      talk(wardenId, "open sesame please"),                 //  3 extra token → NOT exact; vacuous idx8 [#3b,#7 fallback]
      talk(wardenId, "OPEN SESAME!"),                       //  4 case/edge-punct → exact idx0  [#3c]
      talk(wardenId, "how do i get out?"),                  //  5 fuzzy idx3 (reorder+punct)    [#4, #7 real beats vacuous]
      talk(wardenId, "how do i get out of the cellar"),     //  6 idx3 score3 > idx4 score1     [#5]
      talk(wardenId, "open the door"),                      //  7 idx5 (door,"!!!" -> {door})   [#6 TRAP #1]
      talk(wardenId, "help me"),                            //  8 exact idx1 beats fuzzy idx2   [#8]
      talk(wardenId, "key gate"),                           //  9 idx6==idx7 score1 → first     [#9 strict > tie]
      talk(wardenId, "overload"),                           // 10 65 effects → cap violation    [#13]
      talk(castorId, "bless me"),                           // 11 Castor once idx0 FIRES        [#10 fire, npcState]
      talk(castorId, "bless me"),                           // 12 Castor latch set → effect suppressed [#10 suppress, #11 round-trip]
      talk(polluxId, "bless me"),                           // 13 Pollux fires independently    [#12 multi-NPC latch]
    ];
    const steps = writeFacadeFixture(here, "npc-dialogue", SEED, oracle, catalog, ops);

    // ── self-validation: assert the key outcomes in the generated golden ──────────
    type Cue = { kind: string; cue?: { text?: string } };
    type Talk = { error?: string; cues: Cue[] };
    type Char = { id: string; npcState?: unknown };
    type Snap = { campaign: { round: number }; characters: Char[] };

    const texts = (r: Talk): string[] =>
      r.cues.filter((c) => c.kind === "mechanic").map((c) => c.cue?.text ?? "");
    const soleText = (i: number, want: string): void => {
      const r = steps[i]!.result as Talk;
      if (r.error !== undefined) throw new Error(`step ${i}: unexpected error ${r.error}`);
      const t = texts(r);
      if (t.length !== 1 || t[0] !== want) throw new Error(`step ${i}: expected sole cue "${want}", got ${JSON.stringify(t)}`);
    };

    // #1 examine → the Warden's description as a mechanic cue.
    const ex = steps[0]!.result as Cue[];
    if (ex.length !== 1 || ex[0]!.cue?.text !== "A grim warden bars the way.") {
      throw new Error(`step 0: examine must emit the Warden description, got ${JSON.stringify(ex)}`);
    }
    // #2 bare → default.
    soleText(1, "The warden watches you.");
    // #3 exact / exactness / case+edge-punct.
    soleText(2, "The passage opens.");
    soleText(3, "The warden shrugs.");   // extra token defeats exact → vacuous catch-all
    soleText(4, "The passage opens.");
    // #4 fuzzy subset + reorder + trailing punct.
    soleText(5, "Follow the north stair.");
    // #5 highest-score wins (score 3 over score 1).
    soleText(6, "Follow the north stair.");
    // #6 TRAP #1: door,"!!!" normalizes to {door}, hit by "open the door".
    soleText(7, "The door is heavy.");
    // #8 exact beats fuzzy.
    soleText(8, "I will help you.");
    // #9 strict > tie-break → first-authored (key over gate).
    soleText(9, "A key hangs on the wall.");
    // #13 per-event effect cap → error result, NO cues, using the behavior key.
    const cap = steps[10]!.result as Talk;
    if (cap.error !== `NPC '${WARDEN_KEY}' emitted too many effects.`) {
      throw new Error(`step 10: expected effect-cap error, got ${JSON.stringify(cap)}`);
    }
    if (cap.cues.length !== 0) throw new Error("step 10: cap violation must emit no cues");

    // #10 once: 1st fire → response + effect cue AND npcState latch written.
    const fire1 = texts(steps[11]!.result as Talk);
    if (fire1.length !== 2 || fire1[0] !== TWIN_LINE || fire1[1] !== TWIN_GLOW) {
      throw new Error(`step 11: first fire must be [response, glow], got ${JSON.stringify(fire1)}`);
    }
    const castorAfter = (steps[11]!.snapshot as Snap).characters.find((c) => c.id === castorId);
    if (castorAfter?.npcState === undefined) throw new Error("step 11: Castor must have npcState after the once fire");
    // #10 suppression + #11 latch round-trip: 2nd talk → SAME response, NO effect cue.
    soleText(12, TWIN_LINE);
    // #12 multi-NPC independent latches: Pollux fires (2 cues), and after firing
    // each twin's snapshot carries only its own latch.
    const fire3 = texts(steps[13]!.result as Talk);
    if (fire3.length !== 2 || fire3[0] !== TWIN_LINE || fire3[1] !== TWIN_GLOW) {
      throw new Error(`step 13: Pollux must fire independently, got ${JSON.stringify(fire3)}`);
    }
    const s13 = steps[13]!.snapshot as Snap;
    const pollux13 = s13.characters.find((c) => c.id === polluxId);
    if (pollux13?.npcState === undefined) throw new Error("step 13: Pollux must have npcState after its own fire");

    // Talk is FREE: the round never advanced across the whole stream.
    for (const [i, s] of steps.entries()) {
      if ((s.snapshot as Snap).campaign.round !== 0) {
        throw new Error(`step ${i}: talk/examine are free — round must stay 0`);
      }
    }
  });
});
