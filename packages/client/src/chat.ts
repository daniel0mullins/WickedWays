import { applyReaction, type ClientMsg, type ServerMsg, type ChatMsg, type PlayerEntry, type Identity } from "@wickedways/transport-shared";

/**
 * Client-side chat state for the dev harness. Pure state + message-builders (no
 * DOM, no socket) so it is unit-testable; `main.ts` owns the socket and rendering.
 * Messages are kept sorted by `id` so backfill and pagination interleave correctly.
 */
export class ChatClient {
  readonly campaignId: string;
  #messages: ChatMsg[] = [];
  #players: PlayerEntry[] = [];
  #reads: Map<Identity, number> = new Map();
  #typing: Map<Identity, number> = new Map();

  constructor(campaignId = "campaign1") {
    this.campaignId = campaignId;
  }

  get messages(): readonly ChatMsg[] { return this.#messages; }
  get players(): readonly PlayerEntry[] { return this.#players; }
  get reads(): ReadonlyMap<Identity, number> { return this.#reads; }

  /**
   * Returns identities that sent a typing signal within the last `windowMs` milliseconds
   * relative to `now`. Pure and testable — no timers. The DOM timer lives in `main.ts`.
   */
  typingIdentities(now: number, windowMs = 4000): Identity[] {
    const cutoff = now - windowMs;
    const result: Identity[] = [];
    for (const [id, ts] of this.#typing) {
      if (ts >= cutoff) result.push(id);
    }
    return result;
  }

  #insert(msg: ChatMsg): void {
    const i = this.#messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) { this.#messages[i] = msg; return; }
    const at = this.#messages.findIndex((m) => m.id > msg.id);
    if (at < 0) this.#messages.push(msg); else this.#messages.splice(at, 0, msg);
  }

  #patch(id: number, fn: (m: ChatMsg) => ChatMsg): void {
    this.#messages = this.#messages.map((m) => m.id === id ? fn(m) : m);
  }

  onServerMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case "chat": this.#insert(msg.msg); break;
      case "chatHistory": for (const m of msg.msgs) this.#insert(m); break;
      case "players": this.#players = msg.players; break;
      case "chatEdited": this.#patch(msg.id, (m) => ({ ...m, body: msg.body, editedTs: msg.editedTs })); break;
      case "chatDeleted": this.#patch(msg.id, (m) => ({ ...m, deleted: true, body: "", reactions: undefined })); break;
      case "chatReact": this.#patch(msg.id, (m) => ({ ...m, reactions: applyReaction(m.reactions, msg.emoji, msg.identity, msg.on) })); break;
      case "chatReads": {
        const m = new Map<Identity, number>();
        for (const mark of msg.marks) m.set(mark.identity, mark.upTo);
        this.#reads = m;
        break;
      }
      case "typing": this.#typing.set(msg.from, Date.now()); break;
      default: break;
    }
  }

  send(body: string, to?: Identity): ClientMsg {
    return { t: "chatSend", campaignId: this.campaignId, body, to };
  }
}
