/**
 * g2-vault oracle fixture — the TS twin of the G2 MVP author's canonical `Vault`
 * campaign (docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-mvp-design.md,
 * "The TOML surface (MVP)"). This runs the PROVEN TS builders to emit the committed
 * byte-parity TARGETS that the Rust TOML compiler (Tasks 4–5) must match:
 *   • g2-vault.description.json — the assembler's INPUT (names + keys, no minted ids),
 *   • g2-vault.catalog.json     — the item descriptors + the DSL `behaviors` map,
 *   • g2-vault.genesis.json      — the pre-begin genesis `assemble` must reproduce.
 *
 * DUAL ENCODING (every conformance fixture's shape): the door + victory are each
 * authored TWICE for the SAME key —
 *   • native twins in the REGISTRY (a `doorBehavior` `ExitBehavior`, a predicate
 *     `condition` closure, the `createKey` item factory) so the TS `assemble`
 *     validates keys and builds the genesis, AND
 *   • DSL twins in `catalog.behaviors` (`s.exit(...)` / `s.victory(...)`) — the
 *     Rust core interprets these, and they are the byte-parity TARGET the compiler
 *     lowers the TOML expressions to.
 * Real campaigns are TOML-only; this oracle twin is the reference.
 *
 * The victory `test` AST is the byte-parity target for `party[0].room.name == 'Vault'`:
 * it MUST be authored with `index(party, lit(0))` (NOT `first`), matching the
 * compiler's subscript→`Index` mapping.
 *
 * Writes g2-vault.{description,catalog,genesis}.json. Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { createKey } from "wickedways/lib/inventory";
import { Directions } from "wickedways/lib/room";
import type { ICampaign } from "wickedways/lib/campaign";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";
import { doorBehavior } from "../../packages/campaigns/src/hollow-house/content.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62; // "g2"; no rng draws in this pristine pre-begin genesis.

// ── Keys (the names the TOML author writes; ids are minted by `assemble`) ───────
const DOOR_KEY = "vault-door";
const KEY_ITEM_KEY = "vault-key";
const WIN_KEY = "reached-vault";

// The door's opened line — used in BOTH the native `doorBehavior` shadow and the
// DSL `s.exit` twin's `passMessage`, so the two engines' pass cue is byte-identical.
const PASS_MESSAGE = "The lock yields.";
const FAIL_MESSAGE = "The vault door is locked.";

// The `vault-key` factory: a key item with keyCode "vault" (mirrors hollow-house's
// `createKey` keys; `consumeOnUse: false` — a re-usable door key).
const vaultKey = () => createKey({ name: "Vault Key", keyCode: "vault", consumeOnUse: false });

// Native predicate twin of the `reached-vault` victory: the first party member is
// in the Vault. Mirrors the `s.victory` DSL twin authored below (party[0].room.name).
const reachedVault = (c: ICampaign): boolean => c.party[0]?.currentRoom?.name === "Vault";

describe("generate g2-vault oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twins — validated by `assemble`, build the genesis.
    const registry = defineRegistry({
      items: { [KEY_ITEM_KEY]: vaultKey },
      exits: { [DOOR_KEY]: doorBehavior("vault", "vault door", PASS_MESSAGE) },
      conditions: { [WIN_KEY]: reachedVault },
    });

    const template = authorTemplate("Vault", registry, {
      rng,
      maxRounds: 20,
      baseEncounterChance: 0,
    })
      .room("Hall", { description: "A cold stone hall." })
      .room("Vault", { description: "The vault beyond." })
      .startRoom("Hall")
      .exit("Hall", Directions.North, "Vault", {
        behaviorKey: DOOR_KEY,
        initialState: { unlocked: false },
      })
      .loot("shelf", { room: "Hall", items: [KEY_ITEM_KEY] })
      .winWhen(WIN_KEY, { text: "You reached the vault." });

    // (b) DSL behavior twins — interpreted by the Rust core; the byte-parity target.
    const behaviors = {
      [DOOR_KEY]: s.exit({
        canPass: s.hasKey(s.actor, "vault"),
        failMessage: FAIL_MESSAGE,
        passMessage: PASS_MESSAGE,
        // canPass-only door (MVP subset): no statement body.
      }),
      [WIN_KEY]: s.victory(
        s.eq(s.get(s.get(s.index(s.party, s.lit(0)), "room"), "name"), s.lit("Vault")),
      ),
    };

    // Boot the single-PC (player:Ada, NO archetype — the MVP surface declares none)
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
      join(here, "g2-vault.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-vault.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-vault.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the pre-begin oracle matches the MVP surface ────────────
    type Char = { id: string; archetypeId?: string | null };
    type Genesis = {
      campaign: { started: boolean; winConditions?: { key: string }[] };
      rooms: unknown[];
      exits: unknown[];
      characters: Char[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 2) throw new Error(`expected 2 rooms, got ${g.rooms.length}`);
    if (g.exits.length !== 1) throw new Error(`expected 1 exit, got ${g.exits.length}`);
    const win = g.campaign.winConditions ?? [];
    if (!win.some((w) => w.key === WIN_KEY)) {
      throw new Error(`expected a ${WIN_KEY} win condition, got ${JSON.stringify(win)}`);
    }
    const pc = g.characters.find((c) => c.id === "player:Ada");
    if (!pc) throw new Error("genesis must seat player:Ada");
  });
});
