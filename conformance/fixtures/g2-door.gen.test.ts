/**
 * g2-door oracle fixture — the TS twin for the G2 "exit runScript + pass" author
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-expression-surface-design.md).
 * Where `g2-vault` proved a `canPass`-only door, this proves a door with a narration
 * **`runScript`** — the real hollow-house `doorScript` shape: first pass sets
 * `state.unlocked` and returns the opened line; a re-pass is a silent no-op.
 *
 * It exercises the two things this slice lands: the new `runScript` surface on an
 * exit behavior, and the `pass <expr>` statement (legal only in a script body).
 * The body also reuses already-shipped forms — `or`/`stateGet`/`hasKey` (canPass),
 * `when`/`not`/`setState`.
 *
 * DUAL ENCODING: the door is authored TWICE for the key `cellar-door` — the native
 * `doorBehavior` `ExitBehavior` in the REGISTRY (validated by `assemble`, builds the
 * genesis) and the `s.exit(...)` DSL twin in `catalog.behaviors` (interpreted by the
 * Rust core; the byte-parity TARGET the TOML compiler lowers to). Real campaigns are
 * TOML-only; this oracle twin is the reference.
 *
 * Writes g2-door.{description,catalog,genesis}.json. Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { createKey } from "wickedways/lib/inventory";
import { Directions } from "wickedways/lib/room";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";
import { doorBehavior } from "../../packages/campaigns/src/hollow-house/content.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62d0; // "g2do"; no rng draws in this pristine pre-begin genesis.

const DOOR_KEY = "cellar-door";
const KEY_ITEM_KEY = "cellar-key";
const KEY_CODE = "cellar";
// The opened line — used in BOTH the native `doorBehavior` shadow (its `script`
// return) and the DSL `s.pass(...)` twin, so the two engines' pass narration matches.
const OPENED = "The cellar key turns; the cellar door swings open.";

const cellarKey = () => createKey({ name: "Cellar Key", keyCode: KEY_CODE, consumeOnUse: false });

describe("generate g2-door oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twins — validated by `assemble`, build the genesis.
    const registry = defineRegistry({
      items: { [KEY_ITEM_KEY]: cellarKey },
      exits: { [DOOR_KEY]: doorBehavior(KEY_CODE, "cellar door", OPENED) },
    });

    const template = authorTemplate("Door", registry, { rng })
      .room("Hall", { description: "A cold stone hall." })
      .room("Cellar", { description: "The cellar below." })
      .startRoom("Hall")
      .exit("Hall", Directions.South, "Cellar", { behaviorKey: DOOR_KEY })
      .loot("shelf", { room: "Hall", items: [KEY_ITEM_KEY] });

    // (b) DSL behavior twin — interpreted by the Rust core; the byte-parity target.
    //     The real `doorScript` shape: canPass unlocks-or-has-key; the runScript, on
    //     the first pass only, latches `unlocked` and narrates the opened line.
    const behaviors = {
      [DOOR_KEY]: s.exit({
        canPass: s.or(s.stateGet("unlocked", false), s.hasKey(s.actor, KEY_CODE)),
        runScript: [
          s.when(s.not(s.stateGet("unlocked", false)), [
            s.setState("unlocked", s.lit(true)),
            s.pass(s.lit(OPENED)),
          ]),
        ],
        failMessage: "The cellar door won't budge - it's locked.",
      }),
    };

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-door.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-door.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-door.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the runScript carries a `pass` inside a `when` ───────────
    type Genesis = { campaign: { started: boolean }; rooms: unknown[]; exits: unknown[] };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 2) throw new Error(`expected 2 rooms, got ${g.rooms.length}`);
    if (g.exits.length !== 1) throw new Error(`expected 1 exit, got ${g.exits.length}`);

    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      behaviors: Record<string, { family: string; script: { runScript?: { kind: string }[] } }>;
    };
    const script = catalog.behaviors[DOOR_KEY]?.script;
    const when = script?.runScript?.[0] as { then?: { kind: string }[] } | undefined;
    if (!when || !when.then?.some((st) => st.kind === "pass")) {
      throw new Error("door runScript must carry a `pass` statement inside its `when`");
    }
  });
});
