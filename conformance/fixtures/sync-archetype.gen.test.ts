/**
 * Sync selectArchetype-delta golden generator (Phase 2c, sub-project A1).
 *
 * Drives the TS sync `Authority` over a `selectArchetype` setup command and captures the
 * authoritative `{ seq, delta }`. The Rust `SyncAuthority` + `World::select_archetype` must
 * reproduce it (see `crates/wickedways-assemble/tests/sync_gate.rs`).
 *
 * Campaign: a bespoke PRE-START, single-player campaign (setup phase) — one room, one player
 * (Ada) who has joined but NOT yet selected an archetype, with a "delver" archetype registered
 * (baseStats Health→2). selectArchetype draws no rng, so the run is deterministic. beginCampaign
 * is intentionally NOT called (setup commands are only legal before the campaign begins).
 *
 * Writes:
 *   - sync-archetype.genesis.json  (serialized pre-start genesis)
 *   - sync-archetype.golden.json   ({ commands, steps:[{ command, seq, delta }] })
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { Campaign } from "wickedways/lib/campaign";
import { Room } from "wickedways/lib/room";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { CampaignRegistry } from "wickedways/lib/serialization/registry";
import { StatType } from "wickedways/lib/character/stats";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Authority } from "wickedways/lib/sync/authority";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { Command } from "wickedways/lib/sync/types";

const here = dirname(fileURLToPath(import.meta.url));

describe("generate sync-archetype golden", () => {
  it("writes the pre-start genesis + selectArchetype delta golden", () => {
    const campaign = new Campaign({ title: "Setup", maxRounds: 10, knownRecipes: [], rng: () => 0.5 });
    campaign.registerArchetype({
      id: "delver" as ArchetypeId,
      name: "Delver",
      baseStats: { [StatType.Health]: 2 },
    });
    const start = new Room({ name: "Start", description: "the entrance", loot: [] });
    const ada = new PlayerCharacter({ campaign, name: "Ada" });
    ada.joinCampaign();
    ada.move(start);
    // NOT selected, NOT begun — the pre-start setup state.

    const genesis = serializeCampaign(campaign);

    const commands: Command[] = [
      { kind: "selectArchetype", actorId: ada.id, archetypeId: "delver" as ArchetypeId },
    ];

    const auth = new Authority(genesis, { registry: new CampaignRegistry() });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-archetype.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-archetype.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-archetype] steps=${steps.length}`);
  });
});
