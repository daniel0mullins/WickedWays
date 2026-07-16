/**
 * Sync mobAttack-delta golden generator (Phase 2c, sub-project A2).
 *
 * Drives the TS sync `Authority` over a `mobAttack` GM command and captures the authoritative
 * `{ seq, delta }`. The Rust `SyncAuthority` (which thin-binds `mobAttack` to the actor-agnostic
 * `World::attack`) must reproduce it (see `crates/wickedways-assemble/tests/sync_gate.rs`).
 *
 * This is the first **rng-drawing** sync fixture: combat mitigation draws from the campaign rng, so
 * the TS side feeds its Authority `mulberry32(SEED)` and the golden records `SEED`; the Rust
 * `run_gate` seeds the World's rng with the same value (its `Rng::seeded` is the verified
 * mulberry32 twin), so both draw the identical stream and land on the same damage.
 *
 * Campaign: one room (Hall) with Ada (GM, fighter, health 10) and a Rat whose natural attack targets
 * Health. Ada is struck once.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { StatType } from "wickedways/lib/character/stats";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";
import { mulberry32 } from "../seeded-rng.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 1;

describe("generate sync-mobattack golden", () => {
  it("writes the genesis + mobAttack delta golden", () => {
    const setupRng = mulberry32(SEED);
    const registry = defineRegistry({ items: {} });
    const template = authorTemplate("Sync MobAttack (conformance)", registry, {
      rng: setupRng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "fighter", name: "Fighter",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .mob("Rat", {
        stats: { [StatType.Health]: 5, [StatType.Sanity]: 5, [StatType.Energy]: 5 },
        room: "Hall",
        naturalAttack: { stat: StatType.Health, power: 4 },
      });

    const { campaign, rooms } = assemble(template.description, template.registry);
    const hall = rooms.get("Hall")!;

    const ada = new PlayerCharacter({ campaign, name: "Ada", rng: setupRng });
    ada.id = "player:Ada" as CharacterId;
    ada.joinCampaign();
    ada.selectArchetype("fighter" as never);
    ada.move(hall);

    campaign.gm = ada;
    campaign.beginCampaign();

    const genesis = serializeCampaign(campaign);
    const rat = genesis.characters.find((c) => c.kind === "mob")!;

    const commands: Command[] = [
      { kind: "mobAttack", mobId: rat.id as CharacterId, targetId: ada.id },
    ];

    // A FRESH mulberry32(SEED) at submit time — the Rust gate seeds Rng::seeded(SEED) to match.
    const auth = new Authority(genesis, { registry, rng: mulberry32(SEED) });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-mobattack.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-mobattack.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-mobattack] steps=${steps.length}`);
  });
});
