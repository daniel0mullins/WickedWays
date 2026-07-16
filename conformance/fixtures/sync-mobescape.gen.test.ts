/**
 * Sync mobEscape-delta golden generator (Phase 2c, sub-project A2 — final command).
 *
 * Drives the TS sync `Authority` over a `mobEscape` GM command and captures the authoritative
 * `{ seq, delta }`. The Rust `SyncAuthority` + `World::mob_escape` must reproduce it (see
 * `crates/wickedways-assemble/tests/sync_gate.rs`). Rng-drawing (the escape roll + the exit pick),
 * so the golden records the `SEED` and the Rust `run_gate` seeds the same mulberry32 stream.
 *
 * Campaign: two connected rooms (Cell → Hall), Ada (GM) and a Rat in the Cell. The Rat's
 * baseEscapeChance is 100, so the threshold clamps to 100 and it flees through the single exit into
 * the Hall — exercising the full success path (two rng draws + relocation + `escape` history).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { Campaign } from "wickedways/lib/campaign";
import { Room, Directions } from "wickedways/lib/room";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { Mob } from "wickedways/lib/character/mob";
import { CampaignRegistry } from "wickedways/lib/serialization/registry";
import { StatType } from "wickedways/lib/character/stats";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Authority } from "wickedways/lib/sync/authority";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { CharacterId } from "wickedways/lib/character/character";
import type { Command } from "wickedways/lib/sync/types";
import { mulberry32 } from "../seeded-rng.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 1;

describe("generate sync-mobescape golden", () => {
  it("writes the genesis + mobEscape delta golden", () => {
    const setupRng = mulberry32(SEED);
    const campaign = new Campaign({ title: "Sync MobEscape", maxRounds: 20, knownRecipes: [], rng: setupRng });
    campaign.registerArchetype({ id: "fighter" as ArchetypeId, name: "Fighter", baseStats: { [StatType.Health]: 10 } });

    const cell = new Room({ name: "Cell", description: "a cold cell", loot: [] });
    const hall = new Room({ name: "Hall", description: "a stone hall", loot: [] });
    cell.addExit(Directions.North, hall);

    const ada = new PlayerCharacter({ campaign, name: "Ada" });
    ada.id = "player:Ada" as CharacterId;
    ada.joinCampaign();
    ada.selectArchetype("fighter" as ArchetypeId);
    ada.move(cell);

    const rat = new Mob({
      campaign, name: "Rat",
      stats: { [StatType.Health]: 5, [StatType.Sanity]: 5, [StatType.Energy]: 5 },
      inventorySlots: 2, actionsPerRound: 2, drops: [], baseEscapeChance: 100,
    });
    rat.id = "mob:Rat" as CharacterId;
    rat.move(cell);

    campaign.gm = ada;
    campaign.beginCampaign();

    const genesis = serializeCampaign(campaign);
    const commands: Command[] = [{ kind: "mobEscape", mobId: rat.id }];

    const auth = new Authority(genesis, { registry: new CampaignRegistry(), rng: mulberry32(SEED) });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-mobescape.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-mobescape.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-mobescape] steps=${steps.length}`);
  });
});
