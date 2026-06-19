import { DatabaseSync } from "node:sqlite";
import type { CampaignStore, CampaignRecord } from "./store.js";

/**
 * A {@link CampaignStore} backed by Node's built-in `node:sqlite`. One row per
 * campaign; each {@link SqliteStore.save} is a single-row upsert, so snapshot and
 * membership are written atomically (no torn read). WAL mode for crash safety.
 */
export class SqliteStore implements CampaignStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS campaigns (
         campaignId TEXT PRIMARY KEY,
         seq        INTEGER NOT NULL,
         snapshot   TEXT    NOT NULL,
         membership TEXT    NOT NULL,
         updatedAt  INTEGER NOT NULL
       )`,
    );
  }

  load(campaignId: string): Promise<CampaignRecord | null> {
    const row = this.#db
      .prepare("SELECT seq, snapshot, membership FROM campaigns WHERE campaignId = ?")
      .get(campaignId) as { seq: number; snapshot: string; membership: string } | undefined;
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({
      seq: row.seq,
      snapshot: JSON.parse(row.snapshot) as CampaignRecord["snapshot"],
      membership: JSON.parse(row.membership) as CampaignRecord["membership"],
    });
  }

  save(campaignId: string, record: CampaignRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO campaigns (campaignId, seq, snapshot, membership, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(campaignId) DO UPDATE SET
           seq = excluded.seq, snapshot = excluded.snapshot,
           membership = excluded.membership, updatedAt = excluded.updatedAt`,
      )
      .run(campaignId, record.seq, JSON.stringify(record.snapshot), JSON.stringify(record.membership), Date.now());
    return Promise.resolve();
  }

  /** Closes the underlying database (teardown / shutdown). */
  close(): void {
    this.#db.close();
  }
}
