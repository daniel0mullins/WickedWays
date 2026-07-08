/**
 * Descriptor-formation spawn golden generator — the DATA-DRIVEN analog of
 * `spawn.gen.test.ts`. Where that fixture drives the compiled-in native
 * `conformance:wraith` `FormationBehavior`, THIS fixture drives a serializable
 * {@link FormationDescriptor}: the TS oracle spawns via
 * `descriptorToFormation(desc, registry)` (packages/campaigns/src/formations.ts),
 * and the Rust replay resolves the SAME descriptor from `Catalog.formations`
 * (crates/wickedways-core/src/world/{formation_descriptor,formations}.rs). It is
 * THE gate proving the Rust descriptor build + `World::maybe_spawn` drop-seeding
 * and the TS `descriptorToFormation` produce byte-identical spawns — including
 * the rat-tail drop each rat carries.
 *
 * Dogfooding: it uses the REAL Hollow House rat formations (`hollowHouseFormations()`
 * → `rat-single`, `rat-pair`) and the REAL `ratTail` item factory — not stubs.
 *
 * TWO goldens are written, one per formation, so BOTH the single-rat and the
 * two-rat spawn go through the gate with a fully roll-value-INDEPENDENT stream
 * (each campaign arms a single weight-1 formation → `roll(1) == 1` always picks
 * it, exactly like the wraith fixture's single-formation rule):
 *   - formation-descriptor-single.{start.snapshot,catalog,golden}.json
 *   - formation-descriptor-pair.{start.snapshot,catalog,golden}.json
 *
 * Map (per campaign; exit auto-reverses — South returns):
 *   Foyer (lit, start, NO scenes, spawnModifier 0)
 *     ── North ──> Crypt (lit, spawnModifier 1)
 *
 * The Foyer is spawnModifier 0 ON PURPOSE (same reasoning as the wraith fixture):
 * the setup `pc.move(startRoom)` runs `maybeSpawn(Foyer)`, and with
 * baseEncounterChance 100 a default modifier of 1 would spawn the rats in the
 * FOYER before the first captured command. clamp(100×0)=0 → roll(100) ≥ 1 > 0
 * never spawns, for any seed. Crypt threshold = clamp(100×1)=100 → roll(100) ≤ 100
 * always spawns; the weighted select over the single weight-1 formation is
 * roll(1)=1 → also seed-independent.
 *
 * Command stream (single PC "Mara"; budget 3/round):
 *   startTurn;
 *   go N (Foyer→Crypt): maybeSpawn builds the formation, seeds each rat's rat-tail
 *         drop, places them (origin "campaign"), and NOTE_ENCOUNTERS emits one
 *         encounter cue per rat;
 *   go S (Crypt→Foyer): Foyer already visited → no spawn roll;
 *   go N (Foyer→Crypt again): Crypt already visited → NO second spawn; the rats
 *         are already encountered → NO second encounter cue (per-character dedup);
 *         the third budgeted go reaches the 3/round cap → its record_action
 *         auto-ends the turn (silent — no mechanics registered).
 *
 * Catalog carries `formations` (the raw descriptors, byte-faithful to the Rust
 * `Catalog.formations` = `#[serde(default, skip_serializing_if = empty)]`) plus the
 * `rat-tail` item descriptor (so the Rust drop-seeding resolves `cat.items[drop]`).
 * The descriptors carry `bigint` i64 fields (baseEscapeChance 50n, actionsPerRound
 * 2n); a JSON replacer coerces BigInt → Number so serde reads them as JSON
 * integers, matching the shape Rust re-emits.
 *
 * Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { CharacterSnapshot } from "wickedways/lib/serialization/types";
import { structuralClone, viewProjected } from "./gen-helpers.ts";
import { itemToCatalogEntry } from "./scripted-helpers.ts";
import { descriptorToFormation } from "../../packages/campaigns/src/formations.ts";
import { ratTail } from "../../packages/campaigns/src/hollow-house/items.ts";
import { Items, Formations } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseFormations } from "../../packages/campaigns/src/hollow-house/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

// The REAL campaign descriptors (bigint i64 fields — see the header note).
const FORMATIONS = hollowHouseFormations();

type Command =
  | { kind: "startTurn" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] };

/** BigInt → Number so serde reads i64 descriptor fields as JSON integers. */
const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

/**
 * Registry mirroring `buildHauntedHouseRegistry`'s chicken-and-egg: create the
 * registry with the rat-tail item, THEN register both formations (their
 * `descriptorToFormation` build closures dereference the registry lazily at spawn
 * time, so a live reference is enough).
 */
function buildRegistry() {
  const registry = defineRegistry({ items: { [Items.RatTail]: ratTail } });
  registry.registerFormation(
    Formations.RatSingle,
    descriptorToFormation(FORMATIONS[Formations.RatSingle]!, registry),
  );
  registry.registerFormation(
    Formations.RatPair,
    descriptorToFormation(FORMATIONS[Formations.RatPair]!, registry),
  );
  return registry;
}

/** Foyer(start, mod 0) → North → Crypt(mod 1); one armed weight-1 formation. */
function buildCampaign(rng: () => number, formationKey: string) {
  const registry = buildRegistry();
  const template = authorTemplate("Formation Descriptor (conformance)", registry, {
    rng,
    maxRounds: 10,
    baseEncounterChance: 100,
    now: () => 0,
  })
    .archetype({
      id: "delver",
      name: "Delver",
      baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 10 },
    })
    .room("Foyer", { description: "A dusty foyer.", spawnModifier: 0 })
    .room("Crypt", { description: "A silent crypt." })
    .startRoom("Foyer")
    .exit("Foyer", Directions.North, "Crypt")
    .formation(formationKey, { weight: 1 });

  const campaign = startSession(template, {
    players: [{ name: "Mara", archetype: "delver" }],
    gm: 0,
  });
  return campaign;
}

/** Catalog with BOTH descriptors (Rust resolves the armed one) + the rat-tail item. */
function buildCatalogJson(): string {
  const catalog = {
    items: { [Items.RatTail]: itemToCatalogEntry(ratTail()) },
    aliases: {},
    formations: FORMATIONS,
  };
  return JSON.stringify(catalog, bigintReplacer, 2) + "\n";
}

/**
 * Drive one campaign end-to-end for `formationKey`, self-validate the spawn (ids,
 * drops, origin, room, no re-spawn), and write the three fixture files under
 * `prefix`. `expectedRatIds` is the ordered list of mob ids the formation spawns.
 */
function runFixture(prefix: string, formationKey: string, expectedRatIds: string[]) {
  // Fixed seed: draws occur (setup Foyer threshold; Crypt threshold + weighted
  // select) but every outcome is roll-value-independent, so any seed yields the
  // same golden. Coverage is asserted below with hard throws.
  const SEED = 7;
  const rng = mulberry32(SEED);
  const campaign = buildCampaign(rng, formationKey);

  // ── Resolve the map + verify its shape ─────────────────────────────────────
  const foyer = campaign.activeCharacter.currentRoom!;
  if (foyer.name !== "Foyer") throw new Error(`Expected start in "Foyer", got "${foyer.name}"`);
  const FOYER_ID = foyer.id as unknown as string;
  const northExit = foyer.exits.get(Directions.North);
  if (!northExit) throw new Error("Foyer has no North exit.");
  const crypt = northExit.otherSide(foyer);
  if (crypt.name !== "Crypt") throw new Error(`Foyer North should reach "Crypt", got "${crypt.name}"`);
  const CRYPT_ID = crypt.id as unknown as string;
  if (foyer.spawnModifier !== 0) throw new Error(`Foyer spawnModifier must be 0, got ${foyer.spawnModifier}`);
  if (crypt.spawnModifier !== 1) throw new Error(`Crypt spawnModifier must be 1, got ${crypt.spawnModifier}`);

  // ── Genesis snapshot ───────────────────────────────────────────────────────
  const start = structuralClone(serializeCampaign(campaign));
  const et = start.campaign.encounterTable;
  if (et.baseChance !== 100) throw new Error(`baseChance should be 100, got ${et.baseChance}`);
  if (JSON.stringify(et.formations) !== JSON.stringify([{ behaviorKey: formationKey, weight: 1 }])) {
    throw new Error(`encounterTable.formations mismatch: ${JSON.stringify(et.formations)}`);
  }
  if (JSON.stringify(et.visited) !== JSON.stringify([FOYER_ID])) {
    throw new Error(`visited should be exactly ["${FOYER_ID}"] at genesis, got ${JSON.stringify(et.visited)}`);
  }
  if (start.characters.length !== 1) {
    throw new Error(`Genesis should hold only Mara, got ${start.characters.length} characters.`);
  }
  for (const id of expectedRatIds) {
    if (start.characters.some((c) => c.id === id)) throw new Error(`No rat "${id}" may exist at genesis.`);
  }

  // ── Cue capture ────────────────────────────────────────────────────────────
  let buf: PresentationCue[] = [];
  campaign.onCue((c: PresentationCue) => buf.push(c));
  const drain = () => {
    const out = buf;
    buf = [];
    return out;
  };

  const commands: Command[] = [
    { kind: "startTurn" },
    { kind: "go", dir: Directions.North }, // Foyer→Crypt: spawn + encounter cue(s)
    { kind: "go", dir: Directions.South }, // Crypt→Foyer: visited → no spawn
    { kind: "go", dir: Directions.North }, // Foyer→Crypt: no re-spawn, no re-encounter
  ];

  const pcNow = () => campaign.activeCharacter;
  const steps = commands.map((cmd) => {
    switch (cmd.kind) {
      case "startTurn":
        pcNow().startTurn();
        break;
      case "go":
        pcNow().go(cmd.dir);
        break;
    }
    return {
      command: cmd,
      cues: drain(),
      snapshot: structuralClone(serializeCampaign(campaign)),
      view: structuralClone(viewProjected(campaign)),
    };
  });

  // ── Self-validation (hard throws — the stream is deterministic) ─────────────
  const ratIn = (i: number, id: string): CharacterSnapshot | undefined =>
    steps[i]!.snapshot.characters.find((c) => c.id === id);
  const encounterCues = (i: number) =>
    steps[i]!.cues.filter((c): c is Extract<PresentationCue, { kind: "encounter" }> => c.kind === "encounter");

  // (a) startTurn: no rat yet, no encounter cues.
  if (encounterCues(0).length !== 0) throw new Error("Step 0 should emit no encounter cues.");
  for (const id of expectedRatIds) if (ratIn(0, id)) throw new Error(`Step 0: rat "${id}" must not exist yet.`);

  // (b) go N: each rat spawned (origin campaign, in the Crypt), carrying its
  //     `{id}:drop#0` rat-tail; one encounter cue per rat.
  if (steps[1]!.snapshot.characters.length !== 1 + expectedRatIds.length) {
    throw new Error(`Step 1: expected Mara + ${expectedRatIds.length} rat(s), got ${steps[1]!.snapshot.characters.length}.`);
  }
  expectedRatIds.forEach((id) => {
    const rat = ratIn(1, id);
    if (!rat) throw new Error(`Step 1: rat "${id}" missing from snapshot.`);
    if (rat.origin !== "campaign") throw new Error(`Step 1: rat "${id}" origin should be "campaign", got ${JSON.stringify(rat.origin)}`);
    if (rat.currentRoomId !== CRYPT_ID) throw new Error(`Step 1: rat "${id}" should be in the Crypt, got ${String(rat.currentRoomId)}`);
    const dropId = `${id}:drop#0`;
    if (JSON.stringify(rat.inventory.itemIds) !== JSON.stringify([dropId])) {
      throw new Error(`Step 1: rat "${id}" should carry exactly ["${dropId}"], got ${JSON.stringify(rat.inventory.itemIds)}`);
    }
    if (rat.inventory.slots !== 1) throw new Error(`Step 1: rat "${id}" slots should widen to 1, got ${rat.inventory.slots}`);
    const crypt1 = steps[1]!.snapshot.rooms.find((r) => r.name === "Crypt")!;
    if (crypt1.occupantIds.filter((o) => o === id).length !== 1) {
      throw new Error(`Step 1: Crypt occupantIds should list "${id}" exactly once, got ${JSON.stringify(crypt1.occupantIds)}`);
    }
  });
  if (encounterCues(1).length !== expectedRatIds.length) {
    throw new Error(`Step 1 should emit ${expectedRatIds.length} encounter cue(s), got ${encounterCues(1).length}.`);
  }
  const encounteredIds = new Set(encounterCues(1).map((c) => c.mob.id));
  for (const id of expectedRatIds) if (!encounteredIds.has(id)) throw new Error(`Step 1: no encounter cue for "${id}".`);
  if (JSON.stringify(steps[1]!.snapshot.campaign.encounterTable.visited) !== JSON.stringify([FOYER_ID, CRYPT_ID])) {
    throw new Error(`Step 1 visited should be [Foyer, Crypt], got ${JSON.stringify(steps[1]!.snapshot.campaign.encounterTable.visited)}`);
  }

  // (c) return to the Foyer: visited → no spawn, no encounter cues.
  if (encounterCues(2).length !== 0) throw new Error("Step 2 should emit no encounter cues.");

  // (d) re-enter the Crypt: NO second spawn, NO second encounter cue.
  if (encounterCues(3).length !== 0) throw new Error("Step 3 should emit no encounter cue (rats already encountered).");
  if (steps[3]!.snapshot.characters.length !== 1 + expectedRatIds.length) {
    throw new Error(`Step 3: exactly Mara + ${expectedRatIds.length} rat(s) must exist (no re-spawn), got ${steps[3]!.snapshot.characters.length}.`);
  }
  for (const id of expectedRatIds) {
    if (steps[3]!.snapshot.characters.filter((c) => c.id === id).length !== 1) {
      throw new Error(`Step 3: exactly one "${id}" must exist (no re-spawn).`);
    }
  }

  // ── Write files ────────────────────────────────────────────────────────────
  writeFileSync(join(here, `${prefix}.start.snapshot.json`), JSON.stringify(start, null, 2) + "\n");
  writeFileSync(join(here, `${prefix}.catalog.json`), buildCatalogJson());
  writeFileSync(join(here, `${prefix}.golden.json`), JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");

  console.log(`[${prefix}] SEED=${SEED} formation=${formationKey} rats=${JSON.stringify(expectedRatIds)} steps=${steps.length}`);
}

describe("generate descriptor-formation spawn goldens", () => {
  it("writes the single-rat spawn golden (descriptor rat-single + rat-tail drop)", () => {
    runFixture("formation-descriptor-single", Formations.RatSingle, ["campaign-mob:rat"]);
  });

  it("writes the two-rat spawn golden (descriptor rat-pair + both rat-tail drops)", () => {
    runFixture("formation-descriptor-pair", Formations.RatPair, ["campaign-mob:rat", "campaign-mob:rat#2"]);
  });
});
