/**
 * g2-victory oracle fixture — the TS twin for the G2 "victory quantifiers" author
 * slice (docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-expression-surface-design.md).
 * It authors the THREE real hollow-house victory conditions and proves the Rust TOML
 * author reproduces each `test` predicate node-for-node.
 *
 * Exercises this slice's forms — `some`, `every`, `includes`, the `element` subject —
 * plus `first`/`length` from the status-bar slice:
 *   • reached-attic-with-journal (win): `first(party).room.name == 'Attic' &&
 *     hasItem(first(party), 'journal')`
 *   • sanity-zero (lose): `some(party, element.sanity <= 0)`
 *   • party-down (lose): `length(party) > 0 && every(party, includes(element.status, 'ko'))`
 *
 * DUAL ENCODING: each condition is authored TWICE for its key — a native predicate in
 * the REGISTRY (validated by `assemble`; builds the genesis win/lose entries) and the
 * real `s.victory(...)` DSL twin in `catalog.behaviors` (the byte-parity TARGET). Real
 * campaigns are TOML-only; this oracle twin is the reference.
 *
 * Writes g2-victory.{description,catalog,genesis}.json. Run: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import type { ICampaign } from "wickedways/lib/campaign";
import { mulberry32 } from "../seeded-rng.ts";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { OracleSession } from "./oracle-session.ts";
import {
  reachedAtticWithJournalScript,
  sanityZeroScript,
  partyDownScript,
} from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x62_7c; // "g2vc"; no rng draws in this pristine pre-begin genesis.

const WIN_ATTIC = "reached-attic-with-journal";
const LOSE_SANITY = "sanity-zero";
const LOSE_PARTY = "party-down";

// Native predicate twins — never executed in this pre-begin capture; they exist so
// `assemble` can validate the win/lose keys and build the genesis condition entries.
const reachedAttic = (c: ICampaign): boolean => c.party[0]?.currentRoom?.name === "Attic";
const sanityZero = (c: ICampaign): boolean => c.party.some((p) => p.effectiveStat("sanity" as never) <= 0);
const partyDown = (c: ICampaign): boolean => c.party.length > 0;

describe("generate g2-victory oracle fixture", () => {
  it("writes description + catalog + pre-begin single-PC genesis", () => {
    const rng = mulberry32(SEED);

    const registry = defineRegistry({
      items: {},
      conditions: {
        [WIN_ATTIC]: reachedAttic,
        [LOSE_SANITY]: sanityZero,
        [LOSE_PARTY]: partyDown,
      },
    });

    const template = authorTemplate("Victory", registry, { rng })
      .room("Hall", { description: "A cold stone hall." })
      .startRoom("Hall")
      .winWhen(WIN_ATTIC, { text: "You reach the attic, journal in hand." })
      // The TOML author emits win/lose conditions in sorted (BTreeMap) key order —
      // TOML tables are unordered — so author them sorted here: "party-down" before
      // "sanity-zero".
      .loseWhen(LOSE_PARTY, { text: "The party falls." })
      .loseWhen(LOSE_SANITY, { text: "Your mind gives way." });

    // DSL behavior twins — the real hollow-house victory predicates.
    const behaviors = {
      [WIN_ATTIC]: reachedAtticWithJournalScript,
      [LOSE_SANITY]: sanityZeroScript,
      [LOSE_PARTY]: partyDownScript,
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
      join(here, "g2-victory.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-victory.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, behaviors, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "g2-victory.genesis.json"),
      JSON.stringify(oracle.genesis, null, 2) + "\n",
    );

    // ── self-validation ──────────────────────────────────────────────────────────
    type Genesis = {
      campaign: { started: boolean; winConditions?: { key: string }[]; loseConditions?: { key: string }[] };
      characters: { id: string }[];
    };
    const g = oracle.genesis as unknown as Genesis;
    if (g.campaign.started !== false) throw new Error("genesis must be pre-begin (started:false)");
    if (!g.characters.find((c) => c.id === "player:Ada")) throw new Error("genesis must seat player:Ada");
    if (!(g.campaign.winConditions ?? []).some((w) => w.key === WIN_ATTIC)) {
      throw new Error(`missing win condition ${WIN_ATTIC}`);
    }
    const lose = (g.campaign.loseConditions ?? []).map((l) => l.key);
    if (!lose.includes(LOSE_SANITY) || !lose.includes(LOSE_PARTY)) {
      throw new Error(`missing lose conditions, got ${JSON.stringify(lose)}`);
    }
  });
});
