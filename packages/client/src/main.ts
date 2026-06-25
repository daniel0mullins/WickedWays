import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
import type { Command } from "wickedways/lib/sync/types";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import { WebSocketTransport } from "./websocket-transport.js";
import { buildSeedRegistry } from "./seed.js";
import { ChatClient } from "./chat.js";
import { CallClient } from "./call.js";
import type { CallPeer } from "@wickedways/transport-shared";

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

function renderChatPanel(campaign: ReturnType<(typeof SyncCoordinator)["join"]>["campaign"], chatClient: ChatClient, transport: WebSocketTransport): void {
  const policy = campaign.chatPolicy;
  const panelEl = byId("chatPanel");
  const messagesEl = byId("chatMessages");
  const inputEl = document.getElementById("chatInput") as HTMLInputElement | null;
  const sendBtn = document.getElementById("chatSend") as HTMLButtonElement | null;
  const whisperSelectEl = document.getElementById("chatWhisperTo") as HTMLSelectElement | null;

  if (!policy.enabled) {
    panelEl.style.display = "none";
    return;
  }
  panelEl.style.display = "block";

  if (messagesEl && inputEl && sendBtn) {
    messagesEl.innerHTML = "";
    for (const msg of chatClient.messages) {
      const msgDiv = document.createElement("div");
      msgDiv.style.marginBottom = "8px";
      const from = msg.from.slice(0, 8);
      const whisperStr = msg.to ? ` (to ${msg.to.slice(0, 8)})` : "";
      msgDiv.textContent = `[${from}]${whisperStr}: ${msg.body}`;
      messagesEl.appendChild(msgDiv);
    }

    sendBtn.onclick = () => {
      const body = inputEl.value.trim();
      if (!body) return;
      const to = whisperSelectEl && policy.whisper ? (whisperSelectEl.value || undefined) : undefined;
      const sendMsg = chatClient.send(body, to);
      transport.send(sendMsg);
      inputEl.value = "";
    };
  }

  if (whisperSelectEl) {
    if (!policy.whisper) {
      whisperSelectEl.style.display = "none";
    } else {
      whisperSelectEl.style.display = "block";
      whisperSelectEl.innerHTML = '<option value="">Room</option>';
      for (const player of chatClient.players) {
        const opt = document.createElement("option");
        opt.value = player.identity;
        opt.textContent = player.displayName;
        whisperSelectEl.appendChild(opt);
      }
    }
  }
}

async function main(): Promise<void> {
  const chatClient = new ChatClient(campaignId);

  // Call state — defined before connect() so callbacks can safely reference them
  let callActive = false;
  let muted = false;
  let cameraOn = false;
  let callPeers: CallPeer[] = [];

  function renderCallPanel(avEnabled: boolean, avVideo: boolean, transport: WebSocketTransport): void {
    const panelEl = byId("callPanel");
    const tilesEl = byId("callTiles");
    const joinLeaveBtn = byId("callJoinLeave");
    const muteBtn = byId("callMute");
    const cameraBtn = byId("callCamera");

    if (!avEnabled) {
      panelEl.style.display = "none";
      return;
    }
    panelEl.style.display = "block";

    joinLeaveBtn.textContent = callActive ? "Leave call" : "Join call";
    joinLeaveBtn.onclick = () => {
      if (callActive) {
        transport.send({ t: "callLeave", campaignId });
        callClient.leave();
        callActive = false;
        callPeers = [];
      } else {
        transport.send({ t: "callJoin", campaignId });
      }
      renderCallPanel(avEnabled, avVideo, transport);
    };

    muteBtn.style.display = callActive ? "inline-block" : "none";
    muteBtn.textContent = muted ? "Unmute" : "Mute";
    muteBtn.onclick = () => {
      muted = !muted;
      transport.send({ t: "avState", campaignId, muted, cameraOn });
      muteBtn.textContent = muted ? "Unmute" : "Mute";
    };

    cameraBtn.style.display = (callActive && avVideo) ? "inline-block" : "none";
    cameraBtn.textContent = cameraOn ? "Camera off" : "Camera on";
    cameraBtn.onclick = () => {
      cameraOn = !cameraOn;
      transport.send({ t: "avState", campaignId, muted, cameraOn });
      cameraBtn.textContent = cameraOn ? "Camera off" : "Camera on";
    };

    // Re-render tile grid
    tilesEl.innerHTML = "";
    for (const peer of callPeers) {
      const tile = document.createElement("div");
      tile.id = `tile-${peer.peerId}`;
      tile.style.cssText = "border: 1px solid #88c; padding: 8px; min-width: 120px; text-align: center;";
      const name = document.createElement("div");
      name.textContent = peer.displayName;
      tile.appendChild(name);
      const badges = document.createElement("div");
      badges.style.fontSize = "0.8em";
      badges.textContent = `${peer.muted ? "[muted]" : ""} ${peer.cameraOn ? "[cam]" : ""}`.trim();
      tile.appendChild(badges);
      // The <video>/<audio> element is attached by onRemoteStream
      tilesEl.appendChild(tile);
    }
  }

  // Construct CallClient with the real WebRTC seam before connect()
  // transport is passed as a parameter (not captured as a module-level binding)
  // to avoid temporal-dead-zone hazards if signals arrive during handshake.
  const callClient = new CallClient({
    campaignId,
    createPeer: (iceServers) => new RTCPeerConnection({ iceServers: iceServers as RTCIceServer[] }) as unknown as import("./call.js").RtcPeerLike,
    getLocalStream: () => navigator.mediaDevices.getUserMedia({
      audio: true,
      video: cameraOn && coordinatorRef?.campaign.avPolicy.video === true,
    }),
    sendSignal: (to, data) => {
      // transport is assigned before any call message can arrive (callJoined fires
      // only after callJoin is sent, which the user triggers post-connect).
      if (transportRef !== null) {
        transportRef.send({ t: "signal", campaignId, to, data });
      }
    },
    onRemoteStream: (peerId, stream) => {
      const tile = document.getElementById(`tile-${peerId}`);
      if (!tile) return;
      // Remove any existing media element for this peer
      tile.querySelector("video,audio")?.remove();
      const mediaEl = document.createElement("video");
      mediaEl.autoplay = true;
      mediaEl.playsInline = true;
      mediaEl.style.width = "120px";
      mediaEl.srcObject = stream as MediaStream;
      tile.appendChild(mediaEl);
    },
    onPeers: (peers) => {
      callPeers = peers;
      if (coordinatorRef !== null && transportRef !== null) {
        const avPolicy = coordinatorRef.campaign.avPolicy;
        renderCallPanel(avPolicy.enabled, avPolicy.video, transportRef);
      }
    },
  });

  // Refs initialized after connect/join complete; render() guards against pre-init calls
  let coordinatorRef: ReturnType<typeof SyncCoordinator.join> | null = null;
  let transportRef: WebSocketTransport | null = null;

  const render = (): void => {
    // onChat/onCall may fire during handshake before refs are set; guard it
    if (!coordinatorRef || !transportRef) return;
    const c = coordinatorRef.campaign;
    byId("state").textContent = JSON.stringify(
      { head: transportRef.head(), round: c.round, active: c.activeCharacter?.name ?? null, campaign: serializeCampaign(c) },
      null,
      2,
    );
    renderChatPanel(c, chatClient, transportRef);
    renderCallPanel(c.avPolicy.enabled, c.avPolicy.video, transportRef);
  };

  transportRef = await WebSocketTransport.connect({
    url,
    campaignId,
    token: clientId,
    onChat: (msg) => {
      chatClient.onServerMsg(msg);
      render();
    },
    onCall: (msg) => {
      if (msg.t === "callJoined") {
        callActive = true;
        callPeers = msg.peers;
        void callClient.onCallJoined(msg.selfPeerId, msg.peers, msg.iceServers);
      } else if (msg.t === "callPeers") {
        callPeers = msg.peers;
        callClient.onPeersUpdate(msg.peers);
      } else if (msg.t === "signal") {
        void callClient.onSignal(msg.from, msg.data);
      }
      render();
    },
  });
  coordinatorRef = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: transportRef });
  coordinatorRef.start();

  const run = async (label: string, build: () => Command): Promise<void> => {
    const res = await coordinatorRef.submit(build());
    byId("status").textContent = res.ok ? `${label}: ok (seq ${res.seq})` : `${label}: ${res.reason}`;
    render();
  };

  byId("nextPlayer").addEventListener("click", () => void run("nextPlayer", () => ({ kind: "nextPlayer" })));
  byId("moveNorth").addEventListener("click", () =>
    void run("moveNorth", () => {
      const active = coordinatorRef.campaign.activeCharacter;
      if (active === undefined || active.currentRoom === null) throw new Error("no active room");
      const north = active.currentRoom.exits.get(Directions.North);
      if (north === undefined) throw new Error("no North exit");
      return { kind: "move", actorId: active.id, roomId: north.otherSide(active.currentRoom).id };
    }),
  );

  setInterval(render, 250);
  render();
}

void main();
