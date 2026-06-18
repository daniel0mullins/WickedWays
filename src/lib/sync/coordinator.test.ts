import { describe, it, expect } from "vitest";
import { SyncCoordinator } from "./coordinator";
import { InProcessTransport } from "./transport";
import { serializeCampaign } from "../serialization/serializer";
import { PlayerCharacter } from "../character/player-character";
import { SERIALIZE } from "../serialization/symbols";
import { buildStartedCampaign, makeStats } from "../serialization/roundtrip.test-helpers";
import type { LogEntry } from "./types";

describe("SyncCoordinator two-client convergence", () => {
  it("replica B converges to A after each command", () => {
    const { campaign: a, registry } = buildStartedCampaign();
    const transport = new InProcessTransport();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5 });
    // B joins from A's baseline snapshot (A seeds seq 0 on construction).
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });
    A.start(); B.start();

    const active = A.campaign.activeCharacter;
    const dest = [...active.currentRoom!.exits.values()][0]!;
    const res = A.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(res.ok).toBe(true);

    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));
  });

  it("a rejected command leaves the resolver's campaign unchanged", () => {
    const { campaign: a, registry } = buildStartedCampaign();
    const transport = new InProcessTransport();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5 });
    const before = serializeCampaign(A.campaign);
    const notActive = A.campaign.party.find((p) => p.id !== A.campaign.activeCharacter.id)!;
    const res = A.submit({ kind: "move", actorId: notActive.id, roomId: "r" as never });
    expect(res.ok).toBe(false);
    expect(serializeCampaign(A.campaign)).toEqual(before);
  });
});

describe("SyncCoordinator CAS conflict", () => {
  it("a stale-base submit conflicts, then succeeds after re-sync and converges", () => {
    // The race: a foreign writer commits an entry between A's `before` snapshot
    // and A's CAS `append`, bumping head so A's `baseSeq` is stale. RaceTransport
    // injects that foreign entry the first time `append` is called, making the
    // conflict deterministic. The foreign entry carries an empty (no-op) delta so
    // A's #syncTo can apply it without corrupting state.
    const transport = new RaceTransport();
    const { campaign: a, registry } = buildStartedCampaign();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5 });
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });
    A.start(); B.start();

    transport.armForeignOnNextAppend({
      seq: transport.head() + 1,
      baseSeq: transport.head(),
      command: { kind: "nextPlayer" },
      delta: { changed: [], created: [], removed: [] },
    });

    const active = A.campaign.activeCharacter;
    const dest = [...active.currentRoom!.exits.values()][0]!;
    const conflicted = A.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(conflicted.ok).toBe(false);
    expect(conflicted).toMatchObject({ conflict: true });

    // After the conflict the coordinator re-synced to the new head; the retry
    // appends cleanly and both clients converge.
    const retry = A.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(retry.ok).toBe(true);
    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));
  });
});

describe("SyncCoordinator join + late-join", () => {
  it("a newly joined player propagates to a replica via the created-delta", () => {
    const { campaign: a, registry } = buildStartedCampaign();
    const transport = new InProcessTransport();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5 });
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });
    A.start(); B.start();

    // Build a throwaway bare player off A's campaign, snapshot it, submit the join.
    const newcomer = new PlayerCharacter(A.campaign, "Newcomer", makeStats());
    const res = A.submit({ kind: "joinCampaign", character: newcomer[SERIALIZE]() });
    expect(res.ok).toBe(true);

    expect(B.campaign.party.some((p) => p.id === newcomer.id)).toBe(true);
    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));
  });

  it("late-join reconstructs from a checkpoint and replays deltas-since", () => {
    const { campaign: a, registry } = buildStartedCampaign();
    const transport = new InProcessTransport();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5, snapshotEvery: 1 });
    A.start();
    const active = A.campaign.activeCharacter;
    const dest = [...active.currentRoom!.exits.values()][0]!;
    A.submit({ kind: "move", actorId: active.id, roomId: dest.id });

    const C = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("no roll"); } });
    expect(serializeCampaign(C.campaign)).toEqual(serializeCampaign(A.campaign));
  });
});

/**
 * Test-only transport that can inject a foreign entry the first time `append` is
 * called, bumping `head` so the caller's `baseSeq` is stale — a deterministic
 * stand-in for a two-resolver race that is otherwise hard to provoke in-process.
 */
class RaceTransport extends InProcessTransport {
  #armed: LogEntry | null = null;
  armForeignOnNextAppend(entry: LogEntry): void {
    this.#armed = entry;
  }
  override append(entry: LogEntry) {
    if (this.#armed) {
      const foreign = this.#armed;
      this.#armed = null;
      super.append(foreign); // bumps head before the real append is evaluated
    }
    return super.append(entry);
  }
}
