import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
import type { Command } from "wickedways/lib/sync/types";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import { WebSocketTransport } from "./websocket-transport.js";
import { buildSeedRegistry } from "./seed.js";

const params = new URLSearchParams(location.search);
const campaignId = params.get("c") ?? "demo";
const IDENTITY_KEY = "wickedways:identity";
const storedId = localStorage.getItem(IDENTITY_KEY);
const clientId: string = storedId !== null ? storedId : (() => {
  const id = crypto.randomUUID();
  localStorage.setItem(IDENTITY_KEY, id);
  return id;
})();
const url = `ws://${location.hostname}:8787`;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

async function main(): Promise<void> {
  const transport = await WebSocketTransport.connect({ url, campaignId, token: clientId });
  const coordinator = SyncCoordinator.join({ registry: buildSeedRegistry(), transport });
  coordinator.start();

  const render = (): void => {
    const c = coordinator.campaign;
    byId("state").textContent = JSON.stringify(
      { head: transport.head(), round: c.round, active: c.activeCharacter?.name ?? null, campaign: serializeCampaign(c) },
      null,
      2,
    );
  };

  const run = async (label: string, build: () => Command): Promise<void> => {
    const res = await coordinator.submit(build());
    byId("status").textContent = res.ok ? `${label}: ok (seq ${res.seq})` : `${label}: ${res.reason}`;
    render();
  };

  byId("nextPlayer").addEventListener("click", () => void run("nextPlayer", () => ({ kind: "nextPlayer" })));
  byId("moveNorth").addEventListener("click", () =>
    void run("moveNorth", () => {
      const active = coordinator.campaign.activeCharacter;
      if (active === undefined || active.currentRoom === null) throw new Error("no active room");
      const north = active.currentRoom.exits.get(Directions.North);
      if (north === undefined) throw new Error("no North exit");
      return { kind: "move", actorId: active.id, roomId: north.id };
    }),
  );

  setInterval(render, 250);
  render();
}

void main();
