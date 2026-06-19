import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
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

describe("authenticated two-owner scenarios", () => {
  // Two authenticated owners: A = "ada" (GM + owns Ada seat), B = "ben" (owns Ben seat).
  it("two authenticated owners converge; each only acts for its own seat", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" });

    const tA = await connect("ada");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush(); // seed snapshot reaches the server

    const tB = await connect("ben");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();

    // A (GM) assigns the two seed seats to their owners via a raw GM ws connection.
    // Ada is active first (seed invariant); Ben is the other party member.
    const adaId = coordA.campaign.activeCharacter.id;
    const benId = coordA.campaign.party.find((p) => p.id !== adaId)!.id;
    const gmWs = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    await new Promise<void>((r) => gmWs.addEventListener("open", () => r()));
    gmWs.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: adaId, identity: "ada" }));
    gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: benId, identity: "ben" }));
    await flush();
    gmWs.close();

    // Ada is active first: A crafts (Ada, owned), then A nextPlayer (gm), then B moves (Ben, owned).
    const r1 = await coordA.submit({ kind: "craft", actorId: adaId, recipeId: "widget" as RecipeId });
    if (!r1.ok) throw new Error(`craft: ${r1.reason}`);
    await until(() => stateJSON(coordA) === stateJSON(coordB));

    const r2 = await coordA.submit({ kind: "nextPlayer" });
    if (!r2.ok) throw new Error(`nextPlayer: ${r2.reason}`);
    await until(() => stateJSON(coordA) === stateJSON(coordB));

    const benChar = coordB.campaign.activeCharacter;
    const north = benChar.currentRoom!.exits.get(Directions.North)!;
    const r3 = await coordB.submit({ kind: "move", actorId: benId, roomId: north.id });
    if (!r3.ok) throw new Error(`move(ben): ${r3.reason}`);
    await until(() => stateJSON(coordA) === stateJSON(coordB));
  });

  // Anti-spoof: B (owns only Ben) tries to act as Ada -> server denies -> B rolled back, A unaffected.
  it("a client cannot act for a seat it does not own; no divergence results", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" });
    const tA = await connect("ada");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush();
    const tB = await connect("ben");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();

    const adaId = coordA.campaign.activeCharacter.id;
    const benId = coordA.campaign.party.find((p) => p.id !== adaId)!.id;
    const gmWs = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    await new Promise<void>((r) => gmWs.addEventListener("open", () => r()));
    gmWs.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: adaId, identity: "ada" }));
    gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: benId, identity: "ben" }));
    await flush();
    gmWs.close();

    const beforeA = stateJSON(coordA);
    // Ada is active; B (ben) tries to move Ada (B's resolver accepts since Ada is active, but ben != owner of Ada).
    const adaChar = coordB.campaign.activeCharacter;
    const adaNorth = adaChar.currentRoom!.exits.get(Directions.North)!;
    const res = await coordB.submit({ kind: "move", actorId: adaId, roomId: adaNorth.id });
    expect(res.ok).toBe(false);
    expect("rejected" in res && res.rejected).toBe(true); // terminal denial, not a retryable conflict
    await flush();
    expect(stateJSON(coordA)).toBe(beforeA);          // A untouched
    expect(stateJSON(coordB)).toBe(stateJSON(coordA)); // B rolled back to convergence
  });

  // Reconnect re-auth: a valid token reconnects and reconverges; a revoked token is denied.
  it("reconnect re-authenticates; a revoked token is denied on reconnect", async () => {
    let revoked = false;
    handle = await createServer({
      port: 0,
      verifyToken: (t) => (t === "ben" && revoked ? null : t || null),
      gmIdentityFor: () => "ada",
    });
    const tA = await connect("ada");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush();
    const tB = await connect("ben");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();
    await flush();

    // Drop B's socket (unintentional) -> reconnect re-sends join with token "ben" -> still valid -> reconverges.
    sockets[sockets.length - 1]!.close();
    const r = await coordA.submit({ kind: "nextPlayer" });
    if (!r.ok) throw new Error(`nextPlayer: ${r.reason}`);
    await until(() => stateJSON(coordA) === stateJSON(coordB)); // B backfilled after re-auth

    // Now revoke ben's token and drop again -> reconnect join is denied (surfaced; no reconverge).
    revoked = true;
    const headBefore = tB.head();
    sockets[sockets.length - 1]!.close();
    await flush();
    await coordA.submit({ kind: "nextPlayer" }); // commits on the server while B is denied
    await flush();
    expect(tB.head()).toBe(headBefore); // B never re-joined, so it received no further entries
  });
});
