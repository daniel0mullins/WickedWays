import type { SyncTransport, SubmitResult } from "wickedways/lib/sync/transport";
import type { LogEntry, Command } from "wickedways/lib/sync/types";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { parseServerMsg, type ClientMsg, type ServerMsg } from "@wickedways/transport-shared";

/** A message event carrying string data (browser `MessageEvent` and `ws` both satisfy this). */
export interface WSMessageEvent {
  data: unknown;
}

/** The minimal WebSocket surface the transport uses — satisfied by the browser global and by `ws`. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: WSMessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
}

/** Builds a {@link WebSocketLike} for a url. */
export type WebSocketFactory = (url: string) => WebSocketLike;

const browserFactory: WebSocketFactory = (url) => new WebSocket(url);

interface ConnectOpts {
  url: string;
  campaignId: string;
  token: string;
  factory?: WebSocketFactory;
  onPresence?: (p: Extract<ServerMsg, { t: "presence" }>) => void;
  onChat?: (m: Extract<ServerMsg, { t: "chat" | "chatHistory" | "players" }>) => void;
  onCall?: (m: Extract<ServerMsg, { t: "callJoined" | "callPeers" | "signal" }>) => void;
}

/**
 * A concrete {@link SyncTransport} over a WebSocket room server. Keeps a warm
 * local mirror (log + head + snapshot) fed by the server subscription so every
 * synchronous read is served locally; only {@link WebSocketTransport.submit}
 * awaits the server's authoritative verdict. Construct via
 * {@link WebSocketTransport.connect}, which resolves once the mirror has caught up
 * to the server head.
 */
export class WebSocketTransport implements SyncTransport {
  readonly #opts: ConnectOpts;
  readonly #factory: WebSocketFactory;
  #ws: WebSocketLike;
  #closed = false;

  #log: LogEntry[] = [];
  #head = 0;
  #snapshot: { seq: number; snapshot: CampaignSnapshot } | null = null;
  #handlers = new Set<(entry: LogEntry) => void>();
  #buffer = new Map<number, LogEntry>();
  #headWaiters: { target: number; resolve: () => void }[] = [];

  #latestPresence: Extract<ServerMsg, { t: "presence" }> | null = null;
  #pendingSubmit: { resolve: (r: SubmitResult) => void; command: Command } | null = null;
  #snapshotWaiter: ((m: { seq: number; snapshot: unknown }) => void) | null = null;
  #joinedWaiter: ((m: { head: number }) => void) | null = null;
  #openWaiter: (() => void) | null = null;
  #authErrorMsg: string | null = null;

  private constructor(opts: ConnectOpts) {
    this.#opts = opts;
    this.#factory = opts.factory ?? browserFactory;
    this.#ws = this.#open();
  }

  /** Opens a transport and resolves once its mirror has caught up to the server head. */
  static async connect(opts: ConnectOpts): Promise<WebSocketTransport> {
    const t = new WebSocketTransport(opts);
    await t.#handshake();
    return t;
  }

  #open(): WebSocketLike {
    const ws = this.#factory(this.#opts.url);
    ws.addEventListener("open", () => {
      const w = this.#openWaiter;
      this.#openWaiter = null;
      w?.();
    });
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    ws.addEventListener("close", () => {
      if (!this.#closed) void this.#reconnect();
    });
    ws.addEventListener("error", () => {
      /* failures surface as a close event, which drives reconnect */
    });
    return ws;
  }

  async #handshake(): Promise<void> {
    this.#authErrorMsg = null;
    await new Promise<void>((resolve) => (this.#openWaiter = resolve));
    const snap = await new Promise<{ seq: number; snapshot: unknown }>((resolve) => {
      this.#snapshotWaiter = resolve;
      this.#send({ t: "getSnapshot", campaignId: this.#opts.campaignId });
    });
    // The mirror is "caught up to" the snapshot seq even though it holds no
    // entries yet; entries stream from snap.seq+1 onward.
    this.#head = snap.seq;
    this.#snapshot =
      snap.snapshot === null ? null : { seq: snap.seq, snapshot: snap.snapshot as CampaignSnapshot };
    const joined = await this.#join(snap.seq);
    const authErrMsg = this.#authErrorMsg;
    if (authErrMsg !== null) throw new Error(authErrMsg);
    await this.#awaitHead(joined.head);
  }

  async #reconnect(): Promise<void> {
    this.#authErrorMsg = null;
    this.#ws = this.#open();
    await new Promise<void>((resolve) => (this.#openWaiter = resolve));
    const joined = await this.#join(this.#head);
    const reconnectAuthErrMsg = this.#authErrorMsg;
    if (reconnectAuthErrMsg !== null) {
      // Mark closed so the socket's `close` event does not re-fire #reconnect
      // and present the same revoked token in an infinite busy-loop.
      this.#closed = true;
      const p = this.#pendingSubmit;
      this.#pendingSubmit = null;
      p?.resolve({ ok: false, denied: true, reason: reconnectAuthErrMsg });
      return;
    }
    await this.#awaitHead(joined.head);
    // An in-flight submit was lost with the socket: resolve as a terminal denial
    // so the app can resubmit; the replica reconverges from the join backfill.
    const pending = this.#pendingSubmit;
    this.#pendingSubmit = null;
    pending?.resolve({ ok: false, denied: true, reason: "connection lost; resubmit" });
  }

  #join(fromSeq: number): Promise<{ head: number }> {
    return new Promise<{ head: number }>((resolve) => {
      this.#joinedWaiter = resolve;
      this.#send({ t: "join", campaignId: this.#opts.campaignId, token: this.#opts.token, fromSeq });
    });
  }

  #onMessage(data: unknown): void {
    const msg = parseServerMsg(JSON.parse(String(data)));
    if (msg === null) return;
    switch (msg.t) {
      case "snapshot": {
        const w = this.#snapshotWaiter;
        this.#snapshotWaiter = null;
        w?.({ seq: msg.seq, snapshot: msg.snapshot });
        break;
      }
      case "joined": {
        const w = this.#joinedWaiter;
        this.#joinedWaiter = null;
        w?.({ head: msg.head });
        break;
      }
      case "entry":
        this.#applyEntry(msg.entry as unknown as LogEntry);
        break;
      case "committed": {
        const p = this.#pendingSubmit;
        this.#pendingSubmit = null;
        if (p !== null) {
          const entry: LogEntry = { seq: msg.seq, baseSeq: msg.seq - 1, command: p.command, delta: msg.delta as LogEntry["delta"] };
          this.#applyEntry(entry); // apply our own committed delta to the mirror (and subscribers)
          p.resolve({ ok: true, seq: msg.seq, delta: entry.delta });
        }
        break;
      }
      case "denied": {
        // A denied SUBMIT is terminal — resolve the in-flight submit and stop.
        const p = this.#pendingSubmit;
        if (p !== null) {
          this.#pendingSubmit = null;
          p.resolve({ ok: false, denied: true, reason: msg.reason });
          break;
        }
        // Otherwise it's a denied HANDSHAKE (join/reconnect). Record the error, then
        // UNBLOCK the pending waiter(s) by resolving them with a dummy value, so
        // `#handshake`'s `await this.#join(...)` returns and can throw `#authError`.
        this.#authErrorMsg = `auth denied: ${msg.reason}`;
        const sw = this.#snapshotWaiter;
        const jw = this.#joinedWaiter;
        this.#snapshotWaiter = null;
        this.#joinedWaiter = null;
        if (sw !== null) sw({ seq: 0, snapshot: null });
        if (jw !== null) jw({ head: 0 });
        break;
      }
      case "error":
        console.error("room server error:", msg.message);
        break;
      case "presence":
        this.#latestPresence = msg;
        this.#opts.onPresence?.(msg);
        break;
      case "chat":
      case "chatHistory":
      case "players":
        this.#opts.onChat?.(msg);
        break;
      case "callJoined":
      case "callPeers":
      case "signal":
        this.#opts.onCall?.(msg);
        break;
    }
  }

  get latestPresence(): Extract<ServerMsg, { t: "presence" }> | null {
    return this.#latestPresence;
  }

  #applyEntry(entry: LogEntry): void {
    if (entry.seq <= this.#head) return; // duplicate (includes our own committed entry)
    if (entry.seq > this.#head + 1) {
      this.#buffer.set(entry.seq, entry); // gap: hold until the missing seqs arrive
      return;
    }
    this.#commit(entry);
    let next = this.#buffer.get(this.#head + 1);
    while (next !== undefined) {
      this.#buffer.delete(next.seq);
      this.#commit(next);
      next = this.#buffer.get(this.#head + 1);
    }
    this.#checkWaiters();
  }

  #commit(entry: LogEntry): void {
    this.#log.push(entry);
    this.#head = entry.seq;
    for (const h of this.#handlers) h(entry);
  }

  #checkWaiters(): void {
    this.#headWaiters = this.#headWaiters.filter((w) => {
      if (this.#head >= w.target) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  #awaitHead(target: number): Promise<void> {
    if (this.#head >= target) return Promise.resolve();
    return new Promise<void>((resolve) => this.#headWaiters.push({ target, resolve }));
  }

  #send(msg: ClientMsg): void {
    this.#ws.send(JSON.stringify(msg));
  }

  head(): number {
    return this.#head;
  }

  entriesSince(fromSeq: number): LogEntry[] {
    return this.#log.filter((e) => e.seq >= fromSeq);
  }

  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } | null {
    return this.#snapshot;
  }

  submit(command: Command): Promise<SubmitResult> {
    return new Promise<SubmitResult>((resolve) => {
      this.#pendingSubmit = { resolve, command };
      this.#send({ t: "submit", campaignId: this.#opts.campaignId, command });
    });
  }

  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void {
    for (const e of this.#log) if (e.seq >= fromSeq) handler(e);
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Sends a client message (e.g., chat). */
  send(msg: ClientMsg): void {
    this.#send(msg);
  }

  /** Closes the socket without reconnecting (teardown). */
  close(): void {
    this.#closed = true;
    this.#ws.close();
  }
}
