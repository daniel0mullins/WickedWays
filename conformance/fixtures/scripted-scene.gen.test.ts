/**
 * scripted-scene golden — the SCRIPTED-scene (NPC sub-plan 3) end-to-end
 * differential fixture. This is the payoff for Tasks 1-3: it puts the whole
 * data-driven scene path under the authoritative gate — the start-room enter
 * scene surfacing at `begin_campaign`, the `canPlay` predicate, cross-visit state
 * accumulation, the scripted-scene EFFECT channel (`SetVisible`), and the
 * enter/exit phase bodies — all byte-identical Rust core ↔ TS oracle.
 *
 * DUAL ENCODING (the whole point): every scene is authored TWICE for the SAME key:
 *   • a hand-written `SceneBehavior` (preconditions + script closure) in the
 *     REGISTRY — the TS engine fires it (this is the oracle), and
 *   • the matching `scene(...)` DSL `BehaviorScript::Scene` in `catalog.behaviors`
 *     — the Rust core resolves the key there (native-first `resolve_scene` misses,
 *     falls through to the catalog) and interprets it.
 * The gate proves the two encodings produce identical cues + world state.
 *
 * Because the TS `Scene` contract runs ONE phase-agnostic `script` per key, the
 * Vault's distinct enter/exit logic lives under TWO keys (one enter-phase, one
 * exit-phase); the DSL side mirrors that split (an onEnter-only / onExit-only
 * `scene(...)`), which is exactly what `resolve_scene` + `fire_scenes` select by
 * phase on the Rust side.
 *
 * ── Map (single PC "Ada"; both rooms lit; no formations / encounters) ──────────
 *   Threshold (start) ──North──> Vault  (South auto-authored back)
 *     • Threshold carries an ENTER scene `scene/threshold-draft`:
 *         canPlay = NOT state.seen ; onEnter = [ cue, setState seen=true ]
 *       It fires ONCE at `begin_campaign` (start-room surfacing) → its cue lands
 *       in the STARTUP cues and `seen` latches true, so re-entry never re-fires.
 *     • Vault carries an ENTER scene `scene/vault-watch`:
 *         canPlay = state.count < 2 ; onEnter = [ SetVisible(Gargoyle,false),
 *                                                 setState count = count+1 ]
 *       and an EXIT scene `scene/vault-hush`: onExit = [ cue ] (ungated).
 *     • A mob "Gargoyle" is seeded VISIBLE in the Vault; the enter scene hides it.
 *
 * ── Op stream (all `move`; each is one full turn via the facade) ───────────────
 *   0 N Threshold→Vault : vault-watch fires (count 0→1, Gargoyle hidden). NO cue.
 *   1 S Vault→Threshold : vault-hush exit cue; Threshold enter does NOT re-fire.
 *   2 N Threshold→Vault : vault-watch fires again (count 1→2). NO cue.
 *   3 S Vault→Threshold : vault-hush exit cue.
 *   4 N Threshold→Vault : vault-watch canPlay 2<2 FALSE → NO fire (count stays 2).
 *   5 S Vault→Threshold : vault-hush exit cue.
 *
 * PER-OP DISCRIMINATION (each fails if the interpreter were subtly wrong):
 *   • startup cue      — start-room enter-scene surfacing at begin (Task 3).
 *   • step 0 SetVisible — Gargoyle flips visible→false (the effect channel).
 *   • step 0/2 count   — 1 then 2: canPlay TRUE + state accumulation across visits.
 *   • step 4 count==2  — canPlay stops at the cap (a broken gate would write 3).
 *   • steps 1/3/5 cue  — the onExit phase body fires every exit.
 *   • no threshold cue after startup — canPlay + state persistence on the start room.
 *
 * Writes scripted-scene.{genesis,catalog,golden}.json. Run via: pnpm run fixtures:gen
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import { SET_VISIBLE } from "wickedways/lib/inventory";
import type { SceneBehavior } from "wickedways/lib/serialization/registry";
import type { MechanicCue } from "wickedways/lib/mechanics/mechanic";
import { mulberry32 } from "../seeded-rng.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";
import { scene, emit, cue, lit, lt, add, not, stateGet, setState } from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x5ce4e;

// Deterministic id the assembler seats the mob under (mob:<name>); BOTH encodings
// (the TS `SET_VISIBLE` closure below and the DSL `setVisible` template) pin it, so
// no runtime id resolution can drift between the two engines.
const GARGOYLE_ID = "mob:Gargoyle";

const THRESHOLD_KEY = "scene/threshold-draft";
const VAULT_WATCH_KEY = "scene/vault-watch";
const VAULT_HUSH_KEY = "scene/vault-hush";

const THRESHOLD_CUE = "A cold draft stirs the dust of the threshold.";
const HUSH_CUE = "The vault falls silent behind you.";

// ── the scenes, encoding #1: hand-written SceneBehavior closures (the oracle) ───
type Counted = { count?: number };
type Latched = { seen?: boolean };

const thresholdDraftShadow: SceneBehavior = {
  preconditions: [(_room, state) => !((state as Latched).seen ?? false)],
  script: (_room, state): MechanicCue[] => {
    (state as Latched).seen = true;
    return [{ text: THRESHOLD_CUE }];
  },
};

const vaultWatchShadow: SceneBehavior = {
  preconditions: [(_room, state) => ((state as Counted).count ?? 0) < 2],
  script: (room, state): MechanicCue[] => {
    room.occupants.find((o) => o.id === GARGOYLE_ID)?.[SET_VISIBLE](false);
    const s = state as Counted;
    s.count = (s.count ?? 0) + 1;
    return []; // effect-only enter: no cue
  },
};

const vaultHushShadow: SceneBehavior = {
  preconditions: [],
  script: (): MechanicCue[] => [{ text: HUSH_CUE }],
};

// ── the scenes, encoding #2: the `scene(...)` DSL (catalog.behaviors) ───────────
const thresholdDraftBehavior = scene({
  canPlay: not(stateGet("seen", false)),
  onEnter: [emit(cue(lit(THRESHOLD_CUE))), setState("seen", lit(true))],
});

const vaultWatchBehavior = scene({
  canPlay: lt(stateGet("count", 0), lit(2)),
  onEnter: [
    emit({ kind: "setVisible", target: lit(GARGOYLE_ID), visible: lit(false) }),
    setState("count", add(stateGet("count", 0), lit(1))),
  ],
});

const vaultHushBehavior = scene({
  onExit: [emit(cue(lit(HUSH_CUE)))],
});

describe("generate scripted-scene golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({
      items: {},
      scenes: {
        [THRESHOLD_KEY]: thresholdDraftShadow,
        [VAULT_WATCH_KEY]: vaultWatchShadow,
        [VAULT_HUSH_KEY]: vaultHushShadow,
      },
    });

    const template = authorTemplate("Scripted Scene (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Threshold", { description: "A cold stone threshold." })
      .room("Vault", { description: "A silent vault." })
      .startRoom("Threshold")
      .exit("Threshold", Directions.North, "Vault")
      // Gargoyle is seeded VISIBLE in the Vault; the enter scene hides it.
      .mob("Gargoyle", { stats: { [StatType.Health]: 4, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Vault" })
      .scene("Threshold", THRESHOLD_KEY, { phase: "enter" })
      .scene("Vault", VAULT_WATCH_KEY, { phase: "enter" })
      .scene("Vault", VAULT_HUSH_KEY, { phase: "exit" });

    const behaviors = {
      [THRESHOLD_KEY]: thresholdDraftBehavior,
      [VAULT_WATCH_KEY]: vaultWatchBehavior,
      [VAULT_HUSH_KEY]: vaultHushBehavior,
    };
    const catalog = { items: {}, aliases: {}, behaviors };

    const oracle = new OracleSession({
      builder: template, registry, aliases: {}, playerName: "Ada", archetype: "delver", rng, behaviors,
    });

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "move", dir: Directions.North } }, // 0 →Vault : watch fires (count 1)
      { kind: "submit", intent: { kind: "move", dir: Directions.South } }, // 1 →Threshold : hush cue
      { kind: "submit", intent: { kind: "move", dir: Directions.North } }, // 2 →Vault : watch fires (count 2)
      { kind: "submit", intent: { kind: "move", dir: Directions.South } }, // 3 →Threshold : hush cue
      { kind: "submit", intent: { kind: "move", dir: Directions.North } }, // 4 →Vault : canPlay 2<2 false → no fire
      { kind: "submit", intent: { kind: "move", dir: Directions.South } }, // 5 →Threshold : hush cue
    ];
    const steps = writeFacadeFixture(here, "scripted-scene", SEED, oracle, catalog, ops, template.description);

    // ── self-validation: assert the fixture exercises every gated behavior ─────────
    type Cue = { kind: string; cue?: { text?: string } };
    type Res = { error?: string; cues: Cue[] };
    type SceneSnap = { behaviorKey: string; phase: string; state: Record<string, unknown> };
    type RoomSnap = { name: string; scenes: SceneSnap[] };
    type CharSnap = { id: string; visible?: boolean };
    type Snap = { rooms: RoomSnap[]; characters: CharSnap[] };

    const mechText = (cues: Cue[]): string[] =>
      cues.filter((c) => c.kind === "mechanic").map((c) => c.cue?.text ?? "");
    const stepTexts = (i: number): string[] => {
      const r = steps[i]!.result as Res;
      if (r.error !== undefined) throw new Error(`step ${i}: unexpected error ${r.error}`);
      return mechText(r.cues);
    };
    const sceneState = (snap: Snap, room: string, key: string): Record<string, unknown> => {
      const r = snap.rooms.find((x) => x.name === room);
      if (!r) throw new Error(`room "${room}" missing from snapshot`);
      const sc = r.scenes.find((s) => s.behaviorKey === key);
      if (!sc) throw new Error(`scene "${key}" missing from room "${room}"`);
      return sc.state;
    };
    const gargoyleVisible = (snap: Snap): boolean => {
      const g = snap.characters.find((c) => c.id === GARGOYLE_ID);
      if (!g) throw new Error("Gargoyle missing from snapshot");
      return g.visible ?? true; // serializer omits `visible` when true
    };
    const expectTexts = (i: number, want: string[]): void => {
      const got = stepTexts(i);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`step ${i} mechanic cues: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };

    // (1) Start-room scene surfaced at begin_campaign: its cue is in the STARTUP
    //     cues (exactly once) — the delicate Task-3 path.
    const startTexts = mechText(structuralStartupCues(oracle));
    if (JSON.stringify(startTexts) !== JSON.stringify([THRESHOLD_CUE])) {
      throw new Error(`startup cues must be exactly [threshold], got ${JSON.stringify(startTexts)}`);
    }
    // ...and its state advanced from the pristine genesis ({}) to { seen: true }.
    const genesis = oracle.genesis as unknown as Snap;
    if (Object.keys(sceneState(genesis, "Threshold", THRESHOLD_KEY)).length !== 0) {
      throw new Error("genesis threshold scene state must be pristine ({})");
    }
    if (sceneState(steps[0]!.snapshot as Snap, "Threshold", THRESHOLD_KEY)["seen"] !== true) {
      throw new Error("threshold scene state must have advanced to seen=true after begin");
    }
    // Genesis Gargoyle is VISIBLE (serializer omits the flag when true).
    if (!gargoyleVisible(genesis)) throw new Error("genesis Gargoyle must be visible");

    // (2) Vault enter scene: SetVisible effect channel + canPlay + state accumulation.
    expectTexts(0, []);                                   // effect-only enter: no cue
    if (gargoyleVisible(steps[0]!.snapshot as Snap)) throw new Error("step 0: SetVisible must hide Gargoyle");
    if (sceneState(steps[0]!.snapshot as Snap, "Vault", VAULT_WATCH_KEY)["count"] !== 1) {
      throw new Error("step 0: vault-watch count must be 1");
    }
    expectTexts(2, []);
    if (sceneState(steps[2]!.snapshot as Snap, "Vault", VAULT_WATCH_KEY)["count"] !== 2) {
      throw new Error("step 2: vault-watch count must be 2");
    }
    // (3) canPlay stops at the cap: the 3rd enter does NOT fire — count STAYS 2.
    expectTexts(4, []);
    if (sceneState(steps[4]!.snapshot as Snap, "Vault", VAULT_WATCH_KEY)["count"] !== 2) {
      throw new Error("step 4: canPlay must gate the 3rd enter — count must stay 2");
    }

    // (4) onExit phase body fires on every exit (steps 1/3/5), and the start-room
    //     scene never re-fires after startup (no threshold cue in any step).
    expectTexts(1, [HUSH_CUE]);
    expectTexts(3, [HUSH_CUE]);
    expectTexts(5, [HUSH_CUE]);
    for (let i = 0; i < steps.length; i++) {
      if (stepTexts(i).includes(THRESHOLD_CUE)) {
        throw new Error(`step ${i}: the start-room scene must not re-fire after startup`);
      }
    }
  });
});

/** Read the captured startup cues off the oracle (typed narrow for the asserts). */
function structuralStartupCues(oracle: OracleSession): { kind: string; cue?: { text?: string } }[] {
  return oracle.startupCues as unknown as { kind: string; cue?: { text?: string } }[];
}
