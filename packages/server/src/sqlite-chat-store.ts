import { DatabaseSync } from "node:sqlite";
import type { ChatStore, ReadMark } from "./chat-store.js";
import type { ChatMsg, ChatReaction } from "@wickedways/transport-shared";

/**
 * A {@link ChatStore} backed by Node's built-in `node:sqlite`. Two tables:
 * - `chat_messages` — one row per message; `to_id` NULL for room messages.
 * - `chat_reads` — per-identity high-water marks (upserted with MAX).
 *
 * WAL mode for crash safety. `reactions` serialised as JSON; `deleted` as 0/1.
 */
export class SqliteChatStore implements ChatStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS chat_messages (
         campaignId    TEXT    NOT NULL,
         id            INTEGER NOT NULL,
         from_id       TEXT    NOT NULL,
         to_id         TEXT    NULL,
         body          TEXT    NOT NULL,
         ts            INTEGER NOT NULL,
         editedTs      INTEGER NULL,
         deleted       INTEGER NOT NULL DEFAULT 0,
         reactions_json TEXT   NOT NULL DEFAULT '[]',
         PRIMARY KEY (campaignId, id)
       )`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS chat_reads (
         campaignId TEXT    NOT NULL,
         identity   TEXT    NOT NULL,
         upTo       INTEGER NOT NULL,
         PRIMARY KEY (campaignId, identity)
       )`,
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  #rowToMsg(row: RawRow): ChatMsg {
    const reactions = JSON.parse(row.reactions_json) as ChatReaction[];
    return {
      id: row.id,
      from: row.from_id,
      ...(row.to_id !== null ? { to: row.to_id } : {}),
      body: row.body,
      ts: row.ts,
      ...(row.editedTs !== null ? { editedTs: row.editedTs } : {}),
      ...(row.deleted === 1 ? { deleted: true } : {}),
      ...(reactions.length > 0 ? { reactions } : {}),
    };
  }

  // ── ChatStore interface ────────────────────────────────────────────────────

  append(campaignId: string, msg: ChatMsg): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO chat_messages
           (campaignId, id, from_id, to_id, body, ts, editedTs, deleted, reactions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaignId,
        msg.id,
        msg.from,
        msg.to ?? null,
        msg.body,
        msg.ts,
        msg.editedTs ?? null,
        msg.deleted === true ? 1 : 0,
        JSON.stringify(msg.reactions ?? []),
      );
    return Promise.resolve();
  }

  update(campaignId: string, msg: ChatMsg): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO chat_messages
           (campaignId, id, from_id, to_id, body, ts, editedTs, deleted, reactions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaignId, id) DO UPDATE SET
           from_id        = excluded.from_id,
           to_id          = excluded.to_id,
           body           = excluded.body,
           ts             = excluded.ts,
           editedTs       = excluded.editedTs,
           deleted        = excluded.deleted,
           reactions_json = excluded.reactions_json`,
      )
      .run(
        campaignId,
        msg.id,
        msg.from,
        msg.to ?? null,
        msg.body,
        msg.ts,
        msg.editedTs ?? null,
        msg.deleted === true ? 1 : 0,
        JSON.stringify(msg.reactions ?? []),
      );
    return Promise.resolve();
  }

  recent(campaignId: string, identity: string, limit: number): Promise<ChatMsg[]> {
    const rows = this.#db
      .prepare(
        `SELECT id, from_id, to_id, body, ts, editedTs, deleted, reactions_json
           FROM chat_messages
          WHERE campaignId = ?
            AND (to_id IS NULL OR from_id = ? OR to_id = ?)
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(campaignId, identity, identity, limit) as unknown as RawRow[];
    // Reverse to ascending order
    return Promise.resolve(rows.reverse().map((r) => this.#rowToMsg(r)));
  }

  page(
    campaignId: string,
    identity: string,
    before: number,
    limit: number,
  ): Promise<{ msgs: ChatMsg[]; more: boolean }> {
    // Fetch limit+1 rows (newest first) to cheaply detect whether more exist.
    const rows = this.#db
      .prepare(
        `SELECT id, from_id, to_id, body, ts, editedTs, deleted, reactions_json
           FROM chat_messages
          WHERE campaignId = ?
            AND id < ?
            AND (to_id IS NULL OR from_id = ? OR to_id = ?)
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(campaignId, before, identity, identity, limit + 1) as unknown as RawRow[];

    const more = rows.length > limit;
    // Drop the sentinel extra row and reverse to ascending
    const page = rows.slice(0, limit).reverse();
    return Promise.resolve({ msgs: page.map((r) => this.#rowToMsg(r)), more });
  }

  get(campaignId: string, id: number): Promise<ChatMsg | null> {
    const row = this.#db
      .prepare(
        `SELECT id, from_id, to_id, body, ts, editedTs, deleted, reactions_json
           FROM chat_messages
          WHERE campaignId = ? AND id = ?`,
      )
      .get(campaignId, id) as RawRow | undefined;
    return Promise.resolve(row !== undefined ? this.#rowToMsg(row) : null);
  }

  maxId(campaignId: string): Promise<number> {
    const row = this.#db
      .prepare(
        `SELECT MAX(id) AS maxId FROM chat_messages WHERE campaignId = ?`,
      )
      .get(campaignId) as { maxId: number | null } | undefined;
    return Promise.resolve(row?.maxId ?? 0);
  }

  setRead(campaignId: string, identity: string, upTo: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO chat_reads (campaignId, identity, upTo)
         VALUES (?, ?, ?)
         ON CONFLICT(campaignId, identity) DO UPDATE SET
           upTo = MAX(upTo, excluded.upTo)`,
      )
      .run(campaignId, identity, upTo);
    return Promise.resolve();
  }

  reads(campaignId: string): Promise<ReadMark[]> {
    const rows = this.#db
      .prepare(
        `SELECT identity, upTo FROM chat_reads WHERE campaignId = ?`,
      )
      .all(campaignId) as unknown as Array<{ identity: string; upTo: number }>;
    return Promise.resolve(rows.map((r) => ({ identity: r.identity, upTo: r.upTo })));
  }

  /** Closes the underlying database (teardown / shutdown). */
  close(): void {
    this.#db.close();
  }
}

// ── Internal row shape returned by SQLite ────────────────────────────────────

interface RawRow {
  id: number;
  from_id: string;
  to_id: string | null;
  body: string;
  ts: number;
  editedTs: number | null;
  deleted: number;
  reactions_json: string;
}
