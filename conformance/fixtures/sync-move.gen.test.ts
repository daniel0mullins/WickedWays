/**
 * Sync-delta golden generator (Phase 2c, sub-project B differential gate).
 *
 * Drives the **TS sync `Authority`** (`src/lib/sync/authority.ts`) over a Command
 * stream and captures the authoritative `{ seq, delta }` each submit produces. The
 * Rust `SyncAuthority` (native) must reproduce these deltas byte-for-byte given the
 * same genesis + command sequence — that is the differential gate (see the Rust
 * replay in `crates/wickedways-core/src/sync/gate.rs`).
 *
 * Campaign: `buildStartedCampaign` — two connected rooms (Start ⇄ Next), two players
 * (Ada, Ben) in Start, GM = Ada, already begun. No items → no catalog needed (the
 * commands never touch item/behaviour data, so the Rust replay uses a default
 * catalog). Commands are move/nextPlayer only, which draw no rng, so the run is
 * deterministic without a seed.
 *
 * Writes:
 *   - sync-move.genesis.json  (serialized genesis, pre-command)
 *   - sync-move.golden.json   ({ commands, steps:[{ command, seq, delta }] })
 *
 * Run via: pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each `commands[i]` deserializes into the
 * Rust `wickedways_core::sync::Command` enum (#[serde(tag="kind", rename_all="camelCase")]),
 * and each `steps[i].delta` deserializes into the Rust `Delta`.
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

describe("generate sync-move golden", () => {
  it("writes the sync genesis + delta golden", () => {
    const { campaign, registry } = buildStartedCampaign();
    const genesis = serializeCampaign(campaign);

    // Resolve live ids from the built campaign (the Authority's deserialized copy
    // preserves them). Party [Ada, Ben], both in Start; Start has one exit to Next.
    const ada = campaign.party[0]!;
    const ben = campaign.party[1]!;
    const start = ada.currentRoom!;
    const next = [...start.exits.values()][0]!.otherSide(start);

    const commands: Command[] = [
      { kind: "move", actorId: ada.id, roomId: next.id },
      { kind: "nextPlayer" },
      { kind: "move", actorId: ben.id, roomId: next.id },
    ];

    const auth = new Authority(genesis, { registry });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-move.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-move.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-move] steps=${steps.length}`);
  });
});
