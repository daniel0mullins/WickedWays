import { describe, it, expect, vi } from "vitest";
import { SyncCoordinator } from "./coordinator";
import { InProcessTransport } from "./transport";
import { DeltaApplier } from "./delta-applier";
import { serializeCampaign } from "../serialization/serializer";
import { deserializeCampaign } from "../serialization/deserializer";
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

/**
 * Authors a GENUINE foreign `LogEntry` by cloning the given coordinator's CURRENT
 * campaign (so entity ids match the target replica), running a throwaway
 * coordinator over that clone, submitting the command, and capturing the real
 * `{ command, delta }` it produced. The resulting delta carries an actual state
 * change whose entity refs resolve against the target — so it can be replayed on
 * the conflict path, and dropping it would break convergence.
 */
function authorForeignEntry(
  basis: SyncCoordinator,
  registry: Parameters<typeof SyncCoordinator.join>[0]["registry"],
  command: Parameters<SyncCoordinator["submit"]>[0],
): LogEntry {
  const snapshot = serializeCampaign(basis.campaign);
  const clone = deserializeCampaign(snapshot, { registry, rng: () => 0.5 });
  const sibTransport = new InProcessTransport();
  const author = new SyncCoordinator({ campaign: clone, registry, transport: sibTransport, rng: () => 0.5 });
  author.start();
  const res = author.submit(command);
  if (!res.ok) throw new Error("author submit failed");
  return { seq: res.seq, baseSeq: res.seq - 1, command, delta: res.delta };
}

describe("SyncCoordinator CAS conflict", () => {
  it("a stale-base submit conflicts, then re-applies the foreign delta and converges", () => {
    // The race: a foreign writer commits an entry between A's `before` snapshot
    // and A's CAS `append`, bumping head so A's `baseSeq` is stale. RaceTransport
    // injects that foreign entry the first time `append` is called, making the
    // conflict deterministic. Crucially the foreign entry carries a REAL non-empty
    // delta (an authored `nextPlayer`, which advances the active character). The
    // conflict path must restore from `before`, reset #lastApplied to baseSeq, and
    // #syncTo — replaying the foreign delta onto the rebuilt campaign. If the
    // foreign entry were dropped, A would never advance the active character and
    // would diverge from B.
    const transport = new RaceTransport();
    const { campaign: a, registry } = buildStartedCampaign();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5 });
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });
    A.start(); B.start();

    const activeBefore = A.campaign.activeCharacter.id;
    const foreign = authorForeignEntry(A, registry, { kind: "nextPlayer" });
    const foreignIsNonEmpty =
      foreign.delta.campaignCore !== undefined ||
      foreign.delta.changed.length > 0 ||
      foreign.delta.created.length > 0 ||
      foreign.delta.removed.length > 0;
    expect(foreignIsNonEmpty).toBe(true); // a REAL state change, not a no-op
    transport.armForeignOnNextAppend({
      ...foreign,
      seq: transport.head() + 1,
      baseSeq: transport.head(),
    });

    const active = A.campaign.activeCharacter;
    const dest = [...active.currentRoom!.exits.values()][0]!;
    const conflicted = A.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(conflicted.ok).toBe(false);
    expect(conflicted).toMatchObject({ conflict: true });

    // The foreign `nextPlayer` delta must have landed on A after restore+re-sync:
    // the active character changed. (Dropping the foreign entry — the old bug —
    // would leave the active character unchanged.)
    expect(A.campaign.activeCharacter.id).not.toBe(activeBefore);
    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));

    // After the conflict the coordinator re-synced to the new head; the retry
    // appends cleanly and both clients still converge.
    const retryActive = A.campaign.activeCharacter;
    const retryDest = [...retryActive.currentRoom!.exits.values()][0]!;
    const retry = A.submit({ kind: "move", actorId: retryActive.id, roomId: retryDest.id });
    expect(retry.ok).toBe(true);
    expect(serializeCampaign(B.campaign)).toEqual(serializeCampaign(A.campaign));
  });
});

describe("SyncCoordinator own-entry guard", () => {
  it("the submitter does NOT re-apply its own entry; the replica applies it once", () => {
    // Independent of DeltaApplier idempotency: spy on apply and count calls per
    // coordinator. The submitter's local campaign was already advanced by
    // resolver.apply, so re-applying its own synchronous self-notification would
    // be the bug. With #lastApplied advanced BEFORE append, the self-notification
    // sees entry.seq <= #lastApplied and is genuinely skipped.
    const { campaign: a, registry } = buildStartedCampaign();
    const transport = new InProcessTransport();
    const A = new SyncCoordinator({ campaign: a, registry, transport, rng: () => 0.5 });
    const B = SyncCoordinator.join({ registry, transport, rng: () => { throw new Error("replica must not roll"); } });

    // Tag each coordinator's own campaign instance so we can attribute apply calls.
    const aCampaign = A.campaign;
    const bCampaign = B.campaign;
    const applySpy = vi.spyOn(DeltaApplier.prototype, "apply");

    A.start(); B.start();

    const active = A.campaign.activeCharacter;
    const dest = [...active.currentRoom!.exits.values()][0]!;
    const res = A.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(res.ok).toBe(true);

    // Submitter (A) must NOT have applied its own authored entry to its campaign.
    const appliedToA = applySpy.mock.calls.filter((c) => c[0] === aCampaign);
    expect(appliedToA).toHaveLength(0);
    // Replica (B) applies that one entry exactly once.
    const appliedToB = applySpy.mock.calls.filter((c) => c[0] === bCampaign);
    expect(appliedToB).toHaveLength(1);

    applySpy.mockRestore();
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
