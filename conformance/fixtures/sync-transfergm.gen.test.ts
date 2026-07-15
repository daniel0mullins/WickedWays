/**
 * Sync transferGM-delta golden generator (Phase 2c, sub-project A2).
 *
 * Drives the TS sync `Authority` over a `transferGM` GM/lifecycle command and captures the
 * authoritative `{ seq, delta }`. The Rust `SyncAuthority` + `World::transfer_gm` must reproduce it
 * (see `crates/wickedways-assemble/tests/sync_gate.rs`).
 *
 * Campaign: `buildStartedCampaign` — a started two-player campaign (Ada, Ben), GM = Ada. Handing
 * the GM to Ben mutates only `campaign.gmId`, so the delta is a lone campaignCore change and draws
 * no rng.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { buildStartedCampaign } from "wickedways/lib/serialization/roundtrip.test-helpers";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";

const here = dirname(fileURLToPath(import.meta.url));

describe("generate sync-transfergm golden", () => {
  it("writes the genesis + transferGM delta golden", () => {
    const { campaign, registry } = buildStartedCampaign();
    const genesis = serializeCampaign(campaign);

    const ben = campaign.party[1]!;
    const commands: Command[] = [{ kind: "transferGM", characterId: ben.id }];

    const auth = new Authority(genesis, { registry });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-transfergm.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-transfergm.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-transfergm] steps=${steps.length}`);
  });
});
