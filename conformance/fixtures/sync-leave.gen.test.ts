/**
 * Sync leaveCampaign-delta golden generator (Phase 2c, sub-project A2).
 *
 * Drives the TS sync `Authority` over a `leaveCampaign` command and captures the authoritative
 * `{ seq, delta }`. The Rust `SyncAuthority` + `World::leave_campaign` must reproduce it (see
 * `crates/wickedways-assemble/tests/sync_gate.rs`) — this is exactly where the reachability
 * question ("is a departed player pruned from the snapshot, or kept as a room occupant?") is
 * settled by the oracle rather than guessed.
 *
 * Campaign: `buildStartedCampaign` — a started two-player campaign (Ada = GM, Ben). Ben (a
 * non-GM) leaves; no rng is drawn.
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

describe("generate sync-leave golden", () => {
  it("writes the genesis + leaveCampaign delta golden", () => {
    const { campaign, registry } = buildStartedCampaign();
    const genesis = serializeCampaign(campaign);

    const ben = campaign.party[1]!;
    const commands: Command[] = [{ kind: "leaveCampaign", characterId: ben.id }];

    const auth = new Authority(genesis, { registry });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-leave.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-leave.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-leave] steps=${steps.length}`);
  });
});
