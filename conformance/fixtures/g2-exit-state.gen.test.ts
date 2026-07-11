/**
 * g2-exit-state oracle fixture — the TS twin for the G2 "exit name + initialState"
 * description-surface slice
 * (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-description-surface-design.md).
 * Where `g2-door` proved the door's catalog `runScript`, this proves the DESCRIPTION
 * sub-fields the author previously dropped: a keyed door's `name` and its
 * `initialState: { unlocked: false }` (the real hollow-house door shape).
 *
 * Writes g2-exit-state.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
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
import { doorBehavior } from "../../packages/campaigns/src/hollow-house/content.ts";
import { doorScript } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_e5; // "g2es"; no rng draws in this pristine pre-begin genesis.

const DOOR_KEY = "cellar-door";
const OPENED = "The cellar key turns; the cellar door swings open.";

describe("generate g2-exit-state oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({
      items: { "cellar-key": () => createKey({ name: "Cellar Key", keyCode: "cellar", consumeOnUse: false }) },
      exits: { [DOOR_KEY]: doorBehavior("cellar", "cellar door", OPENED) },
    });

    const template = authorTemplate("Exit State", registry, { rng })
      .room("Hall", { description: "A long central hall." })
      .room("Cellar", { description: "The cellar below." })
      .startRoom("Hall")
      // The keyed door carries a display `name` + `initialState` (the two dropped fields).
      .exit("Hall", Directions.South, "Cellar", {
        behaviorKey: DOOR_KEY,
        name: "Cellar Door",
        initialState: { unlocked: false },
      })
      .loot("shelf", { room: "Hall", items: ["cellar-key"] });

    const behaviors = { [DOOR_KEY]: doorScript("cellar", "cellar door", OPENED) };

    const oracle = new OracleSession({
      builder: template,
      registry,
      aliases: {},
      playerName: "Ada",
      rng,
      behaviors,
    });

    writeFileSync(
      join(here, "g2-exit-state.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-exit-state.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-exit-state.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Exit = { name?: string; initialState?: { unlocked: boolean } };
    const desc = stripRng(template.description) as unknown as { exits: Exit[] };
    const door = desc.exits[0];
    if (door?.name !== "Cellar Door") throw new Error("exit must carry the door name");
    if (door?.initialState?.unlocked !== false) throw new Error("exit must carry initialState { unlocked: false }");
  });
});
