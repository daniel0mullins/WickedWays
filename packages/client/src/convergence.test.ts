import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
import type { Command } from "wickedways/lib/sync/types";
import type { RecipeId } from "wickedways/lib/crafting";
import { Directions } from "wickedways/lib/room";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { createServer, type ServerHandle } from "@wickedways/server";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";
import { buildSeedCampaign, buildSeedRegistry } from "./seed.js";

let handle: ServerHandle | null = null;
const sockets: WebSocket[] = [];
const transports: WebSocketTransport[] = [];
const factory: WebSocketFactory = (url) => {
  const s = new WebSocket(url);
  sockets.push(s);
  return s;
};

afterEach(async () => {
  for (const t of transports) t.close();
  transports.length = 0;
  sockets.length = 0;
  await handle?.close();
  handle = null;
});

async function connect(clientId: string): Promise<WebSocketTransport> {
  const t = await WebSocketTransport.connect({
    url: `ws://127.0.0.1:${handle!.port}`,
    campaignId: "demo",
    token: clientId,
    factory,
  });
  transports.push(t);
  return t;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) { resolve(); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error("until: timed out")); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}
const stateJSON = (c: SyncCoordinator): string => JSON.stringify(serializeCampaign(c.campaign));

describe("two-client convergence", () => {
  it("converges A and B after each command in a representative mix", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" });

    const tA = await connect("ada");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush(); // let the seed snapshot reach the server before B joins

    const tB = await connect("b");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();
    expect(stateJSON(coordA)).toBe(stateJSON(coordB)); // identical from the snapshot

    // Pre-assign the seed character seats to "ada" so character-actor appends are authorized.
    const ids = coordA.campaign.party.map((p) => p.id);
    const gmWs = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    await new Promise<void>((r) => gmWs.addEventListener("open", () => r()));
    gmWs.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    for (const id of ids) gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: id, identity: "ada" }));
    await flush(); // let the server apply the assignments before the first append
    gmWs.close();

    const mix: { label: string; build: () => Command }[] = [
      { label: "craft", build: () => ({ kind: "craft", actorId: coordA.campaign.activeCharacter.id, recipeId: "widget" as RecipeId }) },
      { label: "nextPlayer", build: () => ({ kind: "nextPlayer" }) },
      {
        label: "moveNorth",
        build: () => {
          const a = coordA.campaign.activeCharacter;
          const north = a.currentRoom!.exits.get(Directions.North)!;
          return { kind: "move", actorId: a.id, roomId: north.id };
        },
      },
    ];

    for (const { label, build } of mix) {
      const res = await coordA.submit(build());
      if (!res.ok) throw new Error(`${label} rejected: ${res.reason}`);
      await until(() => stateJSON(coordA) === stateJSON(coordB));
    }
  });
});

describe("reconnect", () => {
  it("backfills and converges after B's socket drops", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" });

    const tA = await connect("ada");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush();

    const tB = await connect("b");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();
    await flush();

    // Drop B's underlying socket WITHOUT calling transport.close() (an
    // unintentional drop): the transport's close listener triggers reconnect.
    // B is the second client connected, so its socket is the last one created.
    const bSocket = sockets[sockets.length - 1]!;
    bSocket.close();

    // Commit on A while B is away.
    const res = await coordA.submit({ kind: "nextPlayer" });
    if (!res.ok) throw new Error(`nextPlayer rejected: ${res.reason}`);

    // B auto-reconnects, re-joins from its head, backfills the missed entry, converges.
    await until(() => stateJSON(coordA) === stateJSON(coordB));
  });
});
