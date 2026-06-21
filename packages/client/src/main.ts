import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
import type { Command } from "wickedways/lib/sync/types";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import { WebSocketTransport } from "./websocket-transport.js";
import { buildSeedRegistry } from "./seed.js";
import { ChatClient } from "./chat.js";

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

  // Refs initialized after connect/join complete; render() guards against pre-init calls
  let coordinatorRef: ReturnType<typeof SyncCoordinator.join> | null = null;
  let transportRef: WebSocketTransport | null = null;

  const render = (): void => {
    // onChat may fire during handshake before refs are set; guard it
    if (!coordinatorRef || !transportRef) return;
    const c = coordinatorRef.campaign;
    byId("state").textContent = JSON.stringify(
      { head: transportRef.head(), round: c.round, active: c.activeCharacter?.name ?? null, campaign: serializeCampaign(c) },
      null,
      2,
    );
    renderChatPanel(c, chatClient, transportRef);
  };

  transportRef = await WebSocketTransport.connect({
    url,
    campaignId,
    token: clientId,
    onChat: (msg) => {
      chatClient.onServerMsg(msg);
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
      return { kind: "move", actorId: active.id, roomId: north.id };
    }),
  );

  setInterval(render, 250);
  render();
}

void main();
