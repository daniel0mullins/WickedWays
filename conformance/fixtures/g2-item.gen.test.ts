/**
 * g2-item oracle fixture — the TS twin for the G2 "item bodies" author slice
 * (docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-items-design.md,
 * "The differential gate"). This runs the PROVEN TS builders to emit the committed
 * byte-parity TARGETS that the Rust TOML author (Task 3) must reproduce node-for-node:
 *   • g2-item.description.json — the assembler's INPUT (one room; no minted ids),
 *   • g2-item.catalog.json     — the consumable `ItemDescriptor` + the DSL
 *     `behaviors` map carrying the item's `BehaviorScript::Item` (an `onUse`
 *     statement body emitting `adjustStat`),
 *   • g2-item.genesis.json      — the pre-begin genesis `assemble` must reproduce.
 *
 * DUAL ENCODING (every conformance fixture's shape): the usable consumable is
 * authored for the SAME key `laudanum` —
 *   • the REAL Hollow House `laudanum` factory (items.ts) in the REGISTRY, whose
 *     `use(holder){ holder[ADJUST_STAT](this.stat, this.modifier); }` closure (+6
 *     Sanity) is the differential-gate oracle; `catalogFromRegistry` exports its
 *     descriptor to `catalog.items.laudanum`, AND
 *   • the matching `s.item({ onUse })` DSL `BehaviorScript::Item` in
 *     `catalog.behaviors.laudanum` — the Rust core interprets this, and it is the
 *     byte-parity TARGET the TOML compiler lowers `[behaviors.item.laudanum]` to.
 * The item and its behavior SHARE the key `laudanum` (the engine resolves an item's
 * `onUse` via `catalog.behaviors[item_key]`; `usable:true` on the descriptor enables it).
 * Real campaigns are TOML-only; this oracle twin is the reference.
 *
 * SLICE SUBSET: the `onUse` body emits ONLY `adjustStat` (positive delta +6); no
 * other effect, no `onRead`. The item is DECLARED (registered → in the catalog) but
 * NOT placed, so it need not be reachable at genesis — the static gate compares
 * description + catalog + the pre-begin genesis.
 *
 * RECIPE = AUTHOR-DATA: the descriptor's `recipe` is `{ healing: 1 }` (the laudanum
 * factory's), distinct from the key default `{ item: 1 }`. Consumables vary in recipe
 * (laudanum `healing:1` vs ratTail/journal `item:1`), so it is NOT factory-derived
 * per kind — the TOML surface MUST carry it and Task 3's `lower_item` reads it.
 *
 * Writes g2-item.{description,catalog,genesis}.json. Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import * as s from "../../packages/campaigns/src/scripted/builders.ts";
import { laudanum } from "../../packages/campaigns/src/hollow-house/items.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62; // "g2"; no rng draws in this pristine pre-begin genesis.

// The shared key the item + its behavior are both filed under (the shared-key link).
const ITEM_KEY = "laudanum";

describe("generate g2-item oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    // (a) Native registry twin — the REAL laudanum factory. `assemble` builds the
    //     genesis; `catalogFromRegistry` exports its consumable descriptor. The item
    //     is registered (→ catalog) but not placed (declared, not reachable).
    const registry = defineRegistry({
      items: { [ITEM_KEY]: laudanum },
    });

    const template = authorTemplate("Item", registry, { rng })
      .room("Chamber", { description: "A shuttered apothecary's chamber." })
      .startRoom("Chamber");

    // (b) DSL behavior twin — interpreted by the Rust core; the byte-parity target.
    //     Reproduces the laudanum `use` closure: +6 Sanity to the actor on use.
    const behaviors = {
      [ITEM_KEY]: s.item({
        onUse: [s.emit(s.adjustStat(s.actor, "sanity", s.lit(6)))],
      }),
    };

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
      join(here, "g2-item.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-item.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-item.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation: the pre-begin oracle matches the item surface ───────────
    type Char = { id: string; archetypeId?: string | null };
    type Genesis = {
      campaign: { started: boolean };
      rooms: unknown[];
      characters: Char[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (g.rooms.length !== 1) throw new Error(`expected 1 room, got ${g.rooms.length}`);
    const pc = g.characters.find((c) => c.id === "player:Ada");
    if (!pc) throw new Error("genesis must seat player:Ada");

    // The consumable descriptor + item behavior are the Task 3 byte-parity targets.
    const catalog = catalogFromRegistry(registry, {}, behaviors, {}) as unknown as {
      items: Record<string, { type?: string; usable?: boolean }>;
      behaviors: Record<string, { family: string }>;
    };
    const desc = catalog.items[ITEM_KEY];
    if (!desc || desc.type !== "consumable") throw new Error("item must be a consumable");
    if (catalog.behaviors[ITEM_KEY]?.family !== "item") {
      throw new Error(`behaviors.${ITEM_KEY} must be family "item"`);
    }
  });
});
