import { describe, it, expect } from "vitest";
import { Authority } from "./authority";
import { InProcessTransport } from "./transport";
import { SyncCoordinator } from "./coordinator";
import { serializeCampaign } from "../serialization/serializer";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";
import { Directions } from "../room";

function wire() {
  const { campaign, registry } = buildStartedCampaign();
  const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
  const transport = new InProcessTransport(authority);
  const coordinator = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
  coordinator.start();
  return { registry, transport, coordinator };
}

describe("SyncCoordinator", () => {
  it("applies a legal command to the replica", async () => {
    const { coordinator } = wire();
    const before = coordinator.campaign.activeCharacter.id;
    const res = await coordinator.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    expect(coordinator.campaign.activeCharacter.id).not.toBe(before);
  });

  it("rejects an illegal command and leaves the replica unchanged", async () => {
    const { coordinator } = wire();
    const before = serializeCampaign(coordinator.campaign);
    const res = await coordinator.submit({ kind: "move", actorId: "nobody" as never, roomId: "nowhere" as never });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rejected).toBe(true);
    expect(serializeCampaign(coordinator.campaign)).toEqual(before);
  });

  it("two replicas on one transport converge", async () => {
    const { registry, transport, coordinator: a } = wire();
    const b = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    b.start();
    await a.submit({ kind: "nextPlayer" });
    expect(serializeCampaign(b.campaign)).toEqual(serializeCampaign(a.campaign));
  });

  it("join reconstructs and catches up to head", async () => {
    const { registry, transport, coordinator: a } = wire();
    await a.submit({ kind: "nextPlayer" });
    const b = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    expect(serializeCampaign(b.campaign)).toEqual(serializeCampaign(a.campaign));
  });

  it("stop() prevents further inbound entries from being applied", async () => {
    const { registry, transport, coordinator: a } = wire();
    const b = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    b.start();
    b.stop();
    await a.submit({ kind: "nextPlayer" });
    // b did not apply the inbound entry — its replica is behind a's
    expect(serializeCampaign(b.campaign)).not.toEqual(serializeCampaign(a.campaign));
  });

  it("replica converges via move command", async () => {
    const { registry, transport, coordinator: a } = wire();
    const b = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
    b.start();

    const active = a.campaign.activeCharacter;
    const dest = active.currentRoom!.exits.get(Directions.North)!;
    const res = await a.submit({ kind: "move", actorId: active.id, roomId: dest.id });
    expect(res.ok).toBe(true);
    expect(serializeCampaign(b.campaign)).toEqual(serializeCampaign(a.campaign));
  });

  it("a coordinator never started syncs on submit via #syncTo fallback", async () => {
    const { coordinator } = wire();
    // Not started — no subscription. submit should still apply the committed entry.
    const before = coordinator.campaign.activeCharacter.id;
    const res = await coordinator.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    expect(coordinator.campaign.activeCharacter.id).not.toBe(before);
  });
});
