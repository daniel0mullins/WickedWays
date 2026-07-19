//! Durable campaign persistence (Phase 2c, sub-project C — slice 1).
//!
//! Ports `packages/server/src/store.ts` + `sqlite-store.ts`: the [`CampaignStore`] contract, the
//! [`CampaignRecord`]/[`MembershipState`] durable shapes, and the [`SqliteStore`] implementation
//! (one row per campaign, WAL, a single-row upsert so snapshot + membership are written atomically).
//!
//! The TS `CampaignStore` is async (host-injected `Promise`s). The Rust store is deliberately
//! **synchronous**: rusqlite is a blocking library, and the per-campaign `Table` actor (slice 2)
//! serializes all store access and drives it off the async runtime via
//! `tokio::task::spawn_blocking`. Keeping the trait sync means the actor owns the one blocking
//! boundary and the store stays a plain, testable value.

use std::error::Error;
use std::fmt;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use wickedways_core::CampaignSnapshot;

/// Server-side serializable form of a [`Membership`](crate::membership::Membership): the GM
/// identity + `[characterId, identity]` seat pairs. Mirrors `store.ts` `MembershipState` (the seat
/// list serializes as an array of two-element arrays, exactly like the TS tuple type).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipState {
    pub gm_identity: String,
    pub seats: Vec<(String, String)>,
}

/// One campaign's full durable state, written atomically. Mirrors `store.ts` `CampaignRecord`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CampaignRecord {
    /// The committed head this snapshot represents.
    pub seq: u64,
    /// The engine snapshot (carries `schemaVersion`).
    pub snapshot: CampaignSnapshot,
    /// Seat ownership at this `seq`.
    pub membership: MembershipState,
}

/// A store failure — the SQLite driver, (de)serialization of the JSON columns, or the blocking task
/// that ran the store call failing to complete (e.g. a panic on the blocking pool).
#[derive(Debug)]
pub enum StoreError {
    Db(rusqlite::Error),
    Serde(serde_json::Error),
    Task(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Db(e) => write!(f, "store db error: {e}"),
            StoreError::Serde(e) => write!(f, "store serde error: {e}"),
            StoreError::Task(e) => write!(f, "store task error: {e}"),
        }
    }
}

impl Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Db(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Serde(e)
    }
}

/// Host-injected durable store for campaign records. Implementations MUST make [`save`] atomic: a
/// torn or partial write must never be observable by a later [`load`]. `Send + Sync` so an
/// `Arc<dyn CampaignStore>` can be shared across the runtime and driven from `spawn_blocking`.
///
/// [`save`]: CampaignStore::save
/// [`load`]: CampaignStore::load
pub trait CampaignStore: Send + Sync {
    fn load(&self, campaign_id: &str) -> Result<Option<CampaignRecord>, StoreError>;
    fn save(&self, campaign_id: &str, record: &CampaignRecord) -> Result<(), StoreError>;
}

/// A [`CampaignStore`] backed by SQLite (rusqlite, bundled). One row per campaign; each [`save`] is
/// a single-row upsert, so snapshot and membership land atomically (no torn read). WAL mode for
/// crash safety. Ports `sqlite-store.ts` — same schema, same SQL, parameterized statements only.
///
/// The [`Connection`] is wrapped in a [`Mutex`] to satisfy `Sync` (rusqlite's connection is `Send`
/// but not `Sync`); contention is nil in practice because the per-campaign actor already serializes
/// access.
///
/// [`save`]: CampaignStore::save
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    /// Opens (or creates) the database at `path`, sets WAL + `synchronous = NORMAL`, and ensures
    /// the `campaigns` table exists. `path` may be `:memory:` for an ephemeral store.
    pub fn open(path: &str) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS campaigns (
               campaignId TEXT PRIMARY KEY,
               seq        INTEGER NOT NULL,
               snapshot   TEXT    NOT NULL,
               membership TEXT    NOT NULL,
               updatedAt  INTEGER NOT NULL
             )",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}

impl CampaignStore for SqliteStore {
    fn load(&self, campaign_id: &str) -> Result<Option<CampaignRecord>, StoreError> {
        let conn = self.conn.lock().expect("store mutex poisoned");
        let mut stmt =
            conn.prepare("SELECT seq, snapshot, membership FROM campaigns WHERE campaignId = ?1")?;
        let row = stmt
            .query_row([campaign_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        match row {
            None => Ok(None),
            Some((seq, snapshot, membership)) => Ok(Some(CampaignRecord {
                seq: seq as u64,
                snapshot: serde_json::from_str(&snapshot)?,
                membership: serde_json::from_str(&membership)?,
            })),
        }
    }

    fn save(&self, campaign_id: &str, record: &CampaignRecord) -> Result<(), StoreError> {
        let snapshot = serde_json::to_string(&record.snapshot)?;
        let membership = serde_json::to_string(&record.membership)?;
        let updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock().expect("store mutex poisoned");
        conn.execute(
            "INSERT INTO campaigns (campaignId, seq, snapshot, membership, updatedAt)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(campaignId) DO UPDATE SET
               seq = excluded.seq, snapshot = excluded.snapshot,
               membership = excluded.membership, updatedAt = excluded.updatedAt",
            rusqlite::params![campaign_id, record.seq as i64, snapshot, membership, updated_at],
        )?;
        Ok(())
    }
}

// The store's behavioural tests (round-trip + upsert against a real `CampaignSnapshot`) live in
// `tests/store.rs`: they load a committed genesis fixture, since core's snapshot builders are
// `#[cfg(test)]`-private to that crate and a full `CampaignSnapshot` is impractical to hand-write.
