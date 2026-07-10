/**
 * g2-scene oracle fixture — the TS twin for the G2 "scene bodies" author slice
 * (docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-scenes-design.md,
 * "The differential gate"). This runs the PROVEN TS builders to emit the committed
 * byte-parity TARGETS that the Rust TOML author (Task 3) must reproduce node-for-node:
 *   • g2-scene.description.json — the assembler's INPUT (rooms + the `[[scenes]]`
 *     attachment; no minted ids),
 *   • g2-scene.catalog.json     — the DSL `behaviors` map carrying the scene's
 *     `BehaviorScript::Scene` (canPlay expr + onEnter statement body),
 *   • g2-scene.genesis.json      — the pre-begin genesis `assemble` must reproduce.
 *
 * DUAL ENCODING (every conformance fixture's shape): the scene is authored TWICE for
 * the SAME key —
 *   • a native `SceneBehavior` (preconditions + script closure) in the REGISTRY, so
 *     the TS `assemble`/`beginCampaign` can seat + fire the scene (this validates the
 *     scene key and boots the genesis), AND
 *   • the matching `s.scene(...)` DSL `BehaviorScript::Scene` in `catalog.behaviors`
 *     — the Rust core interprets this, and it is the byte-parity TARGET the TOML
 *     compiler lowers `[behaviors.scene.<key>]` to.
 * Real campaigns are TOML-only; this oracle twin is the reference.
 *
 * FULL-GRAMMAR EXERCISE: to prove EVERY statement form this slice implements (not
 * just the two `scripted-scene` uses), the scene's `onEnter` body uses a `guard`, a
 * nested `when { emit cue; set }`, and a trailing `set`; `canPlay` uses `stateGet`.
 * Byte-parity therefore proves guard + when + setState + emit-cue + the `stateGet`
 * expression. Kept inside the slice's subset: guard/when/setState/emit-cue + stateGet
 * only — no Pass, no SetStateIn, no non-cue effect, no scene initialState.
 *
 * Scenes do NOT fire at genesis (the genesis is captured pre-begin), so the scene's
 * state is pristine ({}) here — exactly what the Rust assembler must reproduce.
 *
 * Writes g2-scene.{description,catalog,genesis}.json. Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import type { SceneBehavior } from "wickedways/lib/serialization/registry";
import type { MechanicCue } from "wickedways/lib/mechanics/mechanic";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62; // "g2"; no rng draws in this pristine pre-begin genesis.

// The scene's key (the name the TOML author writes; ids are minted by `assemble`).
const SCENE_KEY = "scene/threshold-draft";
// The cue the onEnter `when` block emits — byte-identical in BOTH encodings.
const REVEAL_CUE = "A cold draft stirs the dust of the threshold.";

// ── the scene, encoding #1: a hand-written SceneBehavior closure (the oracle) ────
// Seats + fires under the TS engine at `beginCampaign` (AFTER the pre-begin genesis
// is captured, so its output never reaches a committed artifact — it only proves the
// campaign boots). Mirrors the DSL body below: guard round==0 (round is 0 at begin,
// so it proceeds), a `when !revealed` block that emits the cue + sets revealed, then
// sets seen.
type SceneState = { seen?: boolean; revealed?: boolean };
const thresholdShadow: SceneBehavior = {
  preconditions: [(_room, state) => !((state as SceneState).seen ?? false)],
  script: (_room, state): MechanicCue[] => {
    const st = state as SceneState;
    const cues: MechanicCue[] = [];
    if (!(st.revealed ?? false)) {
      cues.push({ text: REVEAL_CUE });
      st.revealed = true;
    }
    st.seen = true;
    return cues;
  },
};

// ── the scene, encoding #2: the `s.scene(...)` DSL (catalog.behaviors) ───────────
// Exercises the FULL statement grammar of this slice: a `guard`, a nested `when`
// (whose body is an `emit cue` + a `setState`), and a trailing `setState`; `canPlay`
// is a `not` over `stateGet`.
const thresholdBehavior = s.scene({
  canPlay: s.not(s.stateGet("seen", false)),
  onEnter: [
    s.guard(s.eq(s.round, s.lit(0))),
    s.when(s.not(s.stateGet("revealed", false)), [
      s.emit(s.cue(s.lit(REVEAL_CUE))),
      s.setState("revealed", s.lit(true)),
    ]),
    s.setState("seen", s.lit(true)),
  ],
});

describe("generate g2-scene oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twin — validated by `assemble`, boots the genesis.
    const registry = defineRegistry({
      items: {},
      scenes: { [SCENE_KEY]: thresholdShadow },
    });

    const template = authorTemplate("Scene", registry, { rng })
      .room("Threshold", { description: "A cold stone threshold." })
      .startRoom("Threshold")
      .scene("Threshold", SCENE_KEY, { phase: "enter" });

    // (b) DSL behavior twin — interpreted by the Rust core; the byte-parity target.
    const behaviors = { [SCENE_KEY]: thresholdBehavior };

    // Boot the single-PC (player:Ada, NO archetype — this surface declares none)
    // pre-begin oracle. `OracleSession` captures the pristine genesis `Authority::new`
    // consumes (exactly what the Rust assembler must reproduce from description+catalog).
    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-scene.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-scene.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-scene.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the pre-begin oracle is well-formed ─────────────────────
    type SceneSnap = { behaviorKey: string; phase: string; state: Record<string, unknown> };
    type RoomSnap = { name: string; scenes: SceneSnap[] };
    type Char = { id: string; archetypeId?: string | null };
    type Genesis = {
      campaign: { started: boolean };
      rooms: RoomSnap[];
      characters: Char[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 1) throw new Error(`expected 1 room, got ${g.rooms.length}`);
    const room = g.rooms.find((r) => r.name === "Threshold");
    if (!room) throw new Error("genesis must carry the Threshold room");
    const sc = room.scenes.find((x) => x.behaviorKey === SCENE_KEY);
    if (!sc) throw new Error(`Threshold must carry the ${SCENE_KEY} scene`);
    if (sc.phase !== "enter") throw new Error(`scene phase must be "enter", got ${sc.phase}`);
    if (Object.keys(sc.state).length !== 0) {
      throw new Error("genesis scene state must be pristine ({}) — scenes do not fire at genesis");
    }
    const pc = g.characters.find((c) => c.id === "player:Ada");
    if (!pc) throw new Error("genesis must seat player:Ada");
  });
});
