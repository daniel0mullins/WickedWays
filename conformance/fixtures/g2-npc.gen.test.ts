/**
 * g2-npc oracle fixture — the TS twin of the G2 npc-dialogue author's canonical
 * Caretaker NPC (docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-npc-design.md,
 * "The npc surface (TOML)"). This runs the PROVEN TS builders to emit the committed
 * byte-parity TARGETS that the Rust TOML compiler (Task 4) must match:
 *   • g2-npc.description.json — the assembler's INPUT (names + keys, no minted ids),
 *     carrying the `NpcDef` (name/stats/room/behavior/holds),
 *   • g2-npc.catalog.json     — the key-item descriptor + the DSL `behaviors` map
 *     (`behaviors["caretaker"]` = the `BehaviorScript::Npc` byte-parity target),
 *   • g2-npc.genesis.json      — the pre-begin genesis `assemble` must reproduce.
 *
 * DUAL ENCODING (every conformance fixture's shape): the caretaker is authored TWICE
 * for the SAME key —
 *   • a native NpcBehavior shadow in the REGISTRY (`{ initialDialogue, dialogue }`)
 *     so the TS `assemble` validates the key, seats the NPC, and mints its held key,
 *     AND
 *   • a DSL twin in `catalog.behaviors` (`s.npc(...)`) — the Rust core interprets
 *     this, and it is the byte-parity TARGET the compiler lowers the TOML behavior to.
 * Real campaigns are TOML-only; this oracle twin is the reference.
 *
 * The caretaker's held-key literals baked into the `default` effects
 * (`npc:Caretaker` + `npc:Caretaker:item#0`) match the ids the assembler mints for
 * an NPC named "Caretaker" holding one item — so the hand-off resolves on both sides.
 * Stays inside the slice subset: only `giveItem`/`setVisible` effects, a `default`
 * (Exact "") plus at least one `Fuzzy` dialogue entry (exercises both match variants).
 *
 * Writes g2-npc.{description,catalog,genesis}.json. Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { createKey } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x6e; // "n" (npc); no rng draws in this pristine pre-begin genesis.

// ── Keys (the names the TOML author writes; ids are minted by `assemble`) ───────
const CARETAKER_KEY = "caretaker";
const KEY_ITEM_KEY = "cellar-key";

// The assembler mints `npc:<name>` for the NPC and `npc:<name>:item#<i>` for each
// held item — matching the literals baked into the `default` effects below.
const CARETAKER_ID = "npc:Caretaker";
const CARETAKER_KEY_ITEM_ID = "npc:Caretaker:item#0";

// Byte-identical text across BOTH twins (the native shadow's initialDialogue and
// the DSL `s.npc` twin). ASCII only — authored to match the TOML surface exactly.
const DESCRIPTION = "A stooped caretaker in a moth-eaten coat, keys trembling at his belt.";
const HANDOFF = "Take the cellar key. I am leaving now.";
const CELLAR_LINE = "It opens the cellar.";

// The `cellar-key` factory: a re-usable key item (keyCode "cellar", consumeOnUse
// false) — mirrors hollow-house's `createKey` cellar key.
const cellarKey = () => createKey({ name: "Cellar Key", keyCode: "cellar", consumeOnUse: false });

describe("generate g2-npc oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twins — validated by `assemble`, seat the NPC + mint its
    // held key. The NpcBehavior shadow's `initialDialogue` is the native no-op
    // fallback; the scripted talk/examine resolve the DSL twin in `behaviors`.
    const registry = defineRegistry({
      items: { [KEY_ITEM_KEY]: cellarKey },
      npcs: { [CARETAKER_KEY]: { initialDialogue: HANDOFF, dialogue: [] } },
    });

    const template = authorTemplate("Caretaker", registry, { rng })
      .room("Foyer", { description: "The gloom of the foyer." })
      .startRoom("Foyer")
      .npc("Caretaker", {
        stats: { [StatType.Health]: 1, [StatType.Sanity]: 1, [StatType.Energy]: 1 },
        room: "Foyer",
        behavior: CARETAKER_KEY,
        holds: [KEY_ITEM_KEY],
      });

    // (b) DSL behavior twin — interpreted by the Rust core; the byte-parity target.
    // A `default` catch-all (Exact "") gives the key + hides the caretaker (once),
    // plus one Fuzzy dialogue entry (exercises the second match variant).
    const behaviors = {
      [CARETAKER_KEY]: s.npc({
        description: DESCRIPTION,
        default: s.entry({
          match: s.exact(""),
          response: s.lit(HANDOFF),
          effects: [
            s.giveItem(s.lit(CARETAKER_ID), s.actor, s.lit(CARETAKER_KEY_ITEM_ID)),
            s.setVisible(s.lit(CARETAKER_ID), s.lit(false)),
          ],
          once: true,
        }),
        dialogue: [
          s.entry({
            match: s.fuzzy("key", "cellar"),
            response: s.lit(CELLAR_LINE),
          }),
        ],
      }),
    };

    // Boot the single-PC (player:Ada, NO archetype — the npc surface declares none)
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
      join(here, "g2-npc.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-npc.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-npc.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the pre-begin oracle matches the npc surface ────────────
    type Char = { id: string; kind: string; npcBehaviorKey?: string; inventory?: { keyIds?: string[] } };
    type Item = { id: string; kind: string; keyCode?: string };
    type Genesis = {
      campaign: { started: boolean };
      rooms: { name: string; occupantIds: string[] }[];
      characters: Char[];
      items: Item[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 1) throw new Error(`expected 1 room, got ${g.rooms.length}`);
    const npc = g.characters.find((c) => c.id === CARETAKER_ID);
    if (!npc) throw new Error("genesis must seat npc:Caretaker");
    if (npc.kind !== "npc") throw new Error(`caretaker must be kind npc, got ${npc.kind}`);
    if (npc.npcBehaviorKey !== CARETAKER_KEY) {
      throw new Error(`caretaker must carry npcBehaviorKey '${CARETAKER_KEY}', got ${String(npc.npcBehaviorKey)}`);
    }
    if (!(npc.inventory?.keyIds ?? []).includes(CARETAKER_KEY_ITEM_ID)) {
      throw new Error(`caretaker must hold the minted key ${CARETAKER_KEY_ITEM_ID}, got ${JSON.stringify(npc.inventory)}`);
    }
    const key = g.items.find((i) => i.id === CARETAKER_KEY_ITEM_ID);
    if (!key || key.kind !== "key" || key.keyCode !== "cellar") {
      throw new Error(`expected a minted cellar key item, got ${JSON.stringify(key)}`);
    }
    const pc = g.characters.find((c) => c.id === "player:Ada");
    if (!pc) throw new Error("genesis must seat player:Ada");
  });
});
