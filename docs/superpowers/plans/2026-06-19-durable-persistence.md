# Durable Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each campaign's authoritative state + seat ownership so a server restart resumes exactly where it left off, and persist the client's identity so a reload keeps its seat.

**Architecture:** A host-injected `CampaignStore` port with one **atomic** `load`/`save` of `{seq, snapshot, membership}`. The server persists the campaign's full snapshot **every commit** (the serialize is already paid by the diff) **before** acking — `flush-before-ack` — via a `SqliteStore` reference adapter (`node:sqlite`, WAL, single-row upsert = atomic). On first access the server loads from the store, falling back to `genesisFor`. The `Authority` stays a pure in-memory unit (one tiny addition: a `startSeq` for seq-continuity across restart); the server's `Table` orchestrates persistence. Persistence is **opt-in**: no `store` injected ⇒ today's ephemeral behavior.

**Tech Stack:** TypeScript (strict, `NodeNext`), pnpm workspaces, vitest, `ws`, Node's built-in `node:sqlite`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-19-durable-persistence-design.md`. Re-read the relevant section before each task.
- **Opt-in persistence.** `createServer` with **no `store`** must behave exactly as today; every existing server/convergence/auth test runs with no store and must stay green.
- **Node ≥ 22.5** for `node:sqlite` (the repo runs v22.18). Add `"engines": { "node": ">=22.5.0" }` to `packages/server/package.json`.
- **`node:sqlite` is experimental** — its `ExperimentalWarning` must be suppressed in tests so output stays pristine (Task 4 wires a vitest setup filter).
- **`save` is atomic:** a torn/partial write must never be observable by `load` (single-row upsert gives this). A `join`'s seat-claim is written in the **same** `save` as its commit (the `onCommit` hook, Task 5).
- **No rng change.** TypeScript strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `NodeNext`. Illegal lifecycle transitions throw `ProceduralViolation`.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit only at the end of each task. Do not push or open a PR unless the user asks.
- Full verification each task: `pnpm checks` (= `pnpm run lint && pnpm run typecheck && pnpm -r run typecheck && pnpm run test`). Every task ends fully green.

---

## File Structure

- `packages/server/src/store.ts` — **new.** The `CampaignStore` port + `CampaignRecord` + `MembershipState` types. The shared vocabulary; no logic.
- `packages/server/src/sqlite-store.ts` — **new.** `SqliteStore` adapter over `node:sqlite`.
- `src/lib/sync/authority.ts` — **modify.** Add optional `startSeq` (seq-continuity across restart).
- `packages/server/src/membership.ts` — **modify.** Add `toState()` / `static fromState()`.
- `packages/server/src/table.ts` — **modify.** `submit` becomes async (persist-before-ack + `onCommit` + reload-on-failure); add `setDurability`, `replaceAuthority`, `head`, `currentSnapshot`, public `persist`/`reload`.
- `packages/server/src/server.ts` — **modify.** `store` option; build durability thunks per `Table`; persist on seat changes; async message handler; (Task 6) load-on-first-access + schema gate.
- `packages/server/src/main.ts` — **modify.** Wire a `SqliteStore` (env-gated).
- `packages/client/src/main.ts` — **modify.** Persist identity in `localStorage`.
- `README.md` — **modify.** Document durable persistence.

---

### Task 1: `CampaignStore` port + types

New file, types only. Purely additive; workspace fully green.

**Files:**
- Create: `packages/server/src/store.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MembershipState { gmIdentity: string; seats: [characterId: string, identity: string][] }
  export interface CampaignRecord { seq: number; snapshot: CampaignSnapshot; membership: MembershipState }
  export interface CampaignStore {
    load(campaignId: string): Promise<CampaignRecord | null>;
    save(campaignId: string, record: CampaignRecord): Promise<void>;
  }
  ```

- [ ] **Step 1: Create `store.ts`**

```ts
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

/** Server-side serializable form of a {@link Membership}: the GM identity + seat→owner pairs. */
export interface MembershipState {
  gmIdentity: string;
  seats: [characterId: string, identity: string][];
}

/** One campaign's full durable state, written atomically. */
export interface CampaignRecord {
  seq: number; // the committed head this snapshot represents
  snapshot: CampaignSnapshot; // engine snapshot (carries schemaVersion)
  membership: MembershipState; // seat ownership at this seq
}

/**
 * Host-injected durable store for campaign records. Implementations MUST make
 * {@link CampaignStore.save} atomic: a torn or partial write must never be
 * observable by a later {@link CampaignStore.load}.
 */
export interface CampaignStore {
  load(campaignId: string): Promise<CampaignRecord | null>;
  save(campaignId: string, record: CampaignRecord): Promise<void>;
}
```

- [ ] **Step 2: Verify it typechecks + commit**

Run: `pnpm checks`
Expected: green (new file, no consumers yet).

```bash
git add packages/server/src/store.ts
git commit -m "$(cat <<'EOF'
feat(server): CampaignStore port + CampaignRecord/MembershipState types

Host-injected durable store interface (atomic load/save of {seq, snapshot,
membership}). No implementation or consumers yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `Authority` seq-continuity (`startSeq`)

Additive engine change: an optional `startSeq` so a restored campaign resumes at its persisted seq instead of resetting to 0. Default `0` preserves all existing behavior.

**Files:**
- Modify: `src/lib/sync/authority.ts`
- Modify: `src/lib/sync/authority.test.ts`

**Interfaces:**
- Produces: `new Authority(genesis, { registry; rng?; snapshotEvery?; startSeq?: number })` — `head()` returns `startSeq` while the log is empty; the first commit is `startSeq + 1`; `loadSnapshot()` starts at `{ seq: startSeq, snapshot: genesis }`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/sync/authority.test.ts`:

```ts
it("resumes at startSeq: head, first commit, and snapshot all reflect the resume point", () => {
  const { campaign, registry } = buildStartedCampaign();
  const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5, startSeq: 7 });
  expect(authority.head()).toBe(7);
  expect(authority.loadSnapshot().seq).toBe(7);
  const res = authority.submit({ kind: "nextPlayer" });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.seq).toBe(8);
  expect(authority.head()).toBe(8);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run src/lib/sync/authority.test.ts -t "resumes at startSeq"`
Expected: FAIL (`head()` is 0, not 7 — `startSeq` not yet honored).

- [ ] **Step 3: Implement `startSeq`**

In `src/lib/sync/authority.ts`:

Add a field after line 26 (`readonly #snapshotEvery: number;`):
```ts
  readonly #startSeq: number;
```

Change the constructor opts type and body (lines 30-39) to:
```ts
  constructor(
    genesis: CampaignSnapshot,
    opts: { registry: CampaignRegistry; rng?: () => number; snapshotEvery?: number; startSeq?: number },
  ) {
    this.#registry = opts.registry;
    this.#rng = opts.rng ?? Math.random;
    this.#snapshotEvery = opts.snapshotEvery ?? 20;
    this.#startSeq = opts.startSeq ?? 0;
    this.#campaign = deserializeCampaign(genesis, { registry: this.#registry, rng: this.#rng });
    this.#snapshot = { seq: this.#startSeq, snapshot: genesis };
  }
```

Change `head()` (lines 42-45) to fall back to `#startSeq`:
```ts
  head(): number {
    const last = this.#log[this.#log.length - 1];
    return last === undefined ? this.#startSeq : last.seq;
  }
```

(`submit` already computes `const seq = this.head() + 1`, so the first post-resume commit is `startSeq + 1` with no further change.)

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm vitest run src/lib/sync/authority.test.ts`
Expected: PASS (the new test + all existing Authority tests — `startSeq` defaults to 0).

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add src/lib/sync/authority.ts src/lib/sync/authority.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): Authority startSeq for resume-after-restart seq continuity

Optional startSeq (default 0) so a campaign restored from a persisted snapshot
resumes at its committed head instead of resetting to 0 — otherwise reconnecting
clients would drop the server's next commit as a duplicate and diverge.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `Membership` serialization

Additive: serialize/deserialize a `Membership` to/from `MembershipState`.

**Files:**
- Modify: `packages/server/src/membership.ts`
- Modify: `packages/server/src/membership.test.ts`

**Interfaces:**
- Consumes: `MembershipState` (Task 1).
- Produces: `membership.toState(): MembershipState`; `Membership.fromState(state: MembershipState): Membership`.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/membership.test.ts`:

```ts
import type { MembershipState } from "./store.js";

it("round-trips through toState / fromState", () => {
  const m = new Membership("gm-1");
  m.claim("ada", "ident-ada");
  m.assign("ben", "ident-ben");
  const state = m.toState();
  expect(state).toEqual({ gmIdentity: "gm-1", seats: [["ada", "ident-ada"], ["ben", "ident-ben"]] });

  const restored = Membership.fromState(state);
  expect(restored.gmIdentity).toBe("gm-1");
  expect(restored.ownerOf("ada")).toBe("ident-ada");
  expect(restored.ownerOf("ben")).toBe("ident-ben");
  expect(restored.toState()).toEqual(state);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run packages/server/src/membership.test.ts -t "round-trips"`
Expected: FAIL (`toState`/`fromState` not defined).

- [ ] **Step 3: Implement `toState` / `fromState`**

In `packages/server/src/membership.ts`:

Add the import at the top:
```ts
import type { Identity, Actor } from "@wickedways/transport-shared";
import type { MembershipState } from "./store.js";
```
(merge with the existing `@wickedways/transport-shared` import; add the `./store.js` line).

Add these methods inside the `Membership` class (e.g. after `transferGM`):
```ts
  /** Serializes the GM identity + seat map for durable storage. */
  toState(): MembershipState {
    return { gmIdentity: this.#gmIdentity, seats: this.seats() };
  }

  /** Rebuilds a Membership from persisted state. */
  static fromState(state: MembershipState): Membership {
    const m = new Membership(state.gmIdentity);
    for (const [characterId, identity] of state.seats) m.assign(characterId, identity);
    return m;
  }
```
(`this.seats()` already returns `[string, Identity][]`, assignable to `[string, string][]` since `Identity = string`.)

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm vitest run packages/server/src/membership.test.ts`
Expected: PASS (new test + existing Membership tests).

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add packages/server/src/membership.ts packages/server/src/membership.test.ts
git commit -m "$(cat <<'EOF'
feat(server): Membership toState/fromState for durable seat ownership

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `SqliteStore` adapter

The reference `CampaignStore` over Node's built-in `node:sqlite`. Additive; workspace green.

**Files:**
- Create: `packages/server/src/sqlite-store.ts`
- Create: `packages/server/src/sqlite-store.test.ts`
- Modify: `packages/server/package.json` (add `engines.node`)
- Modify: the root vitest config (suppress the `node:sqlite` experimental warning) — see Step 1

**Interfaces:**
- Consumes: `CampaignStore`, `CampaignRecord` (Task 1).
- Produces: `class SqliteStore implements CampaignStore { constructor(path: string); /* load, save */; close(): void }`.

- [ ] **Step 1: Suppress the `node:sqlite` experimental warning in tests**

Find the root vitest config (`vitest.config.ts` or `vite.config.ts` at the repo root — read it). Add a setup file to `test.setupFiles` (create the array if absent):

Create `vitest.setup.ts` at the repo root:
```ts
// Drop Node's `ExperimentalWarning` for the built-in node:sqlite module so test
// output stays pristine. Targeted: only that one warning is filtered.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
```

In the vitest config, ensure `test: { setupFiles: ["./vitest.setup.ts"] }` (merge with existing `test` options). If an eslint `allowDefaultProject` list governs root config files, add `vitest.setup.ts` to it.

- [ ] **Step 2: Add the Node engines floor**

In `packages/server/package.json`, add a top-level field:
```json
  "engines": { "node": ">=22.5.0" },
```

- [ ] **Step 3: Write the failing test**

Create `packages/server/src/sqlite-store.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { SqliteStore } from "./sqlite-store.js";
import type { CampaignRecord } from "./store.js";

function record(seq: number): CampaignRecord {
  return {
    seq,
    snapshot: { schemaVersion: 1 } as unknown as CampaignRecord["snapshot"],
    membership: { gmIdentity: "gm", seats: [["ada", "ident-ada"]] },
  };
}

describe("SqliteStore", () => {
  let store: SqliteStore | null = null;
  afterEach(() => { store?.close(); store = null; });

  it("returns null for an unknown campaign", async () => {
    store = new SqliteStore(":memory:");
    expect(await store.load("nope")).toBeNull();
  });

  it("round-trips a record", async () => {
    store = new SqliteStore(":memory:");
    await store.save("demo", record(3));
    expect(await store.load("demo")).toEqual(record(3));
  });

  it("upserts: a second save for the same id wins", async () => {
    store = new SqliteStore(":memory:");
    await store.save("demo", record(3));
    await store.save("demo", record(4));
    expect((await store.load("demo"))?.seq).toBe(4);
  });
});
```

- [ ] **Step 4: Run it — verify it fails**

Run: `pnpm vitest run packages/server/src/sqlite-store.test.ts`
Expected: FAIL (`Cannot find module './sqlite-store'`).

- [ ] **Step 5: Implement `SqliteStore`**

Create `packages/server/src/sqlite-store.ts`:

```ts
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
```

> If `@types/node` is too old to type `node:sqlite`, bump `@types/node` in `packages/server/package.json` to a version that includes it (≥ 22.5 typings) and `pnpm install`. The `.get()`/`.run()` casts above bridge the loosely-typed rows.

- [ ] **Step 6: Run the test — verify it passes**

Run: `pnpm vitest run packages/server/src/sqlite-store.test.ts`
Expected: PASS (3 tests), with **no** experimental-warning noise in the output (Step 1).

- [ ] **Step 7: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add packages/server/src/sqlite-store.ts packages/server/src/sqlite-store.test.ts packages/server/package.json vitest.setup.ts vitest.config.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(server): SqliteStore — durable CampaignStore over node:sqlite

Single-row-per-campaign upsert (atomic snapshot+membership), WAL mode. Node
engines floor >=22.5; the experimental-feature warning is filtered in tests.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

(Adjust the `git add` list to the actual root vitest config filename you edited.)

---

### Task 5: Server write path — persist-before-ack + rollback

Make the server persist on every commit and seat change, before acking, with rollback on persist failure. **The server still starts each campaign from `genesisFor`** (load-on-restart is Task 6). All changes are within `packages/server`; the no-store path is unchanged, so the workspace stays green.

**Files:**
- Modify: `packages/server/src/table.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/src/table.test.ts`
- Modify: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `CampaignStore`/`CampaignRecord` (Task 1), `Membership.toState` (Task 3), `Authority` `startSeq` (Task 2).
- Produces:
  ```ts
  // Table
  setDurability(hooks: { persist: () => Promise<void>; reload: () => Promise<void> }): void;
  replaceAuthority(authority: Authority): void;
  head(): number;
  currentSnapshot(): CampaignSnapshot;
  persist(): Promise<void>;
  reload(): Promise<void>;
  submit(command: Command, sender: Subscriber, onCommit?: () => void):
    Promise<{ committed: true; seq: number } | { committed: false }>;   // now async
  // createServer options gains: store?: CampaignStore
  ```

- [ ] **Step 1: Make `Table` durability-aware**

Replace `packages/server/src/table.ts` with:

```ts
import type { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";

/** A connected participant: receives ordered server messages for one {@link Table}. */
export type Subscriber = (msg: ServerMsg) => void;

/**
 * The server-side coordinator for one campaign's session — the virtual tabletop.
 * Wraps the engine {@link Authority} (the single source of truth) and the
 * participant set, emitting ordered messages through {@link Subscriber} callbacks.
 * The submitter receives `committed{seq,delta}`; every other participant receives
 * `entry{seq,delta}`. When durability hooks are set, a commit is persisted BEFORE
 * it is acked/broadcast (flush-before-ack); a persist failure rolls the campaign
 * back via `reload` and denies the submitter. Named `Table` (not `Room`) to avoid
 * colliding with the engine's game-location `Room`.
 */
export class Table {
  #authority: Authority;
  #participants = new Set<Subscriber>();
  #persist: () => Promise<void> = () => Promise.resolve();
  #reload: () => Promise<void> = () => Promise.resolve();

  constructor(authority: Authority) {
    this.#authority = authority;
  }

  /** Installs the durability hooks (no-ops until set; the ephemeral path never sets them). */
  setDurability(hooks: { persist: () => Promise<void>; reload: () => Promise<void> }): void {
    this.#persist = hooks.persist;
    this.#reload = hooks.reload;
  }

  /** Swaps in a rebuilt authority (used by `reload` after a persist failure). */
  replaceAuthority(authority: Authority): void {
    this.#authority = authority;
  }

  /** Highest committed seq (0 when empty). */
  head(): number {
    return this.#authority.head();
  }

  /** The authority's current head snapshot (what `persist` writes). */
  currentSnapshot(): CampaignSnapshot {
    return this.#authority.loadSnapshot().snapshot;
  }

  /** Writes the current durable record (no-op without hooks). */
  persist(): Promise<void> {
    return this.#persist();
  }

  /** Rebuilds the authority/membership from the last durable record (no-op without hooks). */
  reload(): Promise<void> {
    return this.#reload();
  }

  /** Registers a participant, acks the current head, then backfills entries after `fromSeq`. */
  join(sub: Subscriber, fromSeq: number): void {
    this.#participants.add(sub);
    sub({ t: "joined", head: this.head() });
    for (const e of this.#authority.entriesSince(fromSeq + 1)) {
      sub({ t: "entry", entry: e as unknown as WireLogEntry });
    }
  }

  /** Removes a participant (e.g. on disconnect). */
  leave(sub: Subscriber): void {
    this.#participants.delete(sub);
  }

  /**
   * Resolves a command through the authority. `onCommit` (if given) runs AFTER the
   * in-memory commit and BEFORE persistence, so a seat-claim it performs is written
   * in the SAME atomic `save` as the commit. On commit: persist (flush-before-ack),
   * then ack `sender` with `committed` and broadcast `entry` to every OTHER
   * participant. On a persist failure: `reload` (discarding the un-persisted commit
   * and any `onCommit` mutation) and reply `denied` to `sender` only. On an
   * authority denial: reply `denied` to `sender` only.
   */
  async submit(
    command: Command,
    sender: Subscriber,
    onCommit?: () => void,
  ): Promise<{ committed: true; seq: number } | { committed: false }> {
    const res = this.#authority.submit(command);
    if (!res.ok) {
      sender({ t: "denied", reason: res.reason });
      return { committed: false };
    }
    onCommit?.();
    try {
      await this.#persist();
    } catch {
      await this.#reload(); // revert campaign + membership to the last durable record
      sender({ t: "denied", reason: "could not persist; retry" });
      return { committed: false };
    }
    const entry: WireLogEntry = { seq: res.seq, baseSeq: res.seq - 1, command, delta: res.delta };
    sender({ t: "committed", seq: res.seq, delta: res.delta });
    for (const p of this.#participants) if (p !== sender) p({ t: "entry", entry });
    return { committed: true, seq: res.seq };
  }

  /** Sends the authority's latest checkpoint to `requester`. */
  sendSnapshot(requester: Subscriber): void {
    const snap = this.#authority.loadSnapshot();
    requester({ t: "snapshot", seq: snap.seq, snapshot: snap.snapshot });
  }

  /** Sends a server message to every current participant (used for presence). */
  broadcast(msg: ServerMsg): void {
    for (const p of this.#participants) p(msg);
  }
}
```

- [ ] **Step 2: Wire the store + durability into `server.ts`**

In `packages/server/src/server.ts`:

Add the import:
```ts
import type { CampaignStore } from "./store.js";
```

Add to `ServerOptions` (after `rng?`):
```ts
  /** Optional durable store; when omitted the server is ephemeral (today's behavior). */
  store?: CampaignStore;
```

Factor a `buildAuthority` helper and have `tableFor` install durability hooks. Replace the `tableFor` block (lines 50-61) with:

```ts
  const tables = new Map<string, Table>();

  const buildAuthority = (id: string, seq: number, genesis: CampaignSnapshot): Authority =>
    new Authority(genesis, { registry: opts.registry, rng: opts.rng, snapshotEvery: 1, startSeq: seq });

  const tableFor = (id: string): Table | null => {
    let t = tables.get(id);
    if (t === undefined) {
      const genesis = opts.genesisFor(id);
      if (genesis === null) return null;
      const authority = buildAuthority(id, 0, genesis); // Task 6 resumes from a persisted seq
      memberships.set(id, new Membership(opts.gmIdentityFor(id)));
      t = new Table(authority);
      const store = opts.store;
      if (store !== undefined) {
        t.setDurability({
          persist: () =>
            store.save(id, { seq: t!.head(), snapshot: t!.currentSnapshot(), membership: membershipFor(id).toState() }),
          reload: async () => {
            const rec = await store.load(id);
            const fresh = rec?.snapshot ?? opts.genesisFor(id);
            if (fresh === null) return; // nothing to restore to
            t!.replaceAuthority(buildAuthority(id, rec?.seq ?? 0, fresh));
            memberships.set(id, rec ? Membership.fromState(rec.membership) : new Membership(opts.gmIdentityFor(id)));
          },
        });
      }
      tables.set(id, t);
    }
    return t;
  };
```

Add the `CampaignSnapshot` + `Membership` imports if not already present (they are: `Membership` is imported; `CampaignSnapshot` is imported). Note `memberships`/`membershipFor` are declared just below — move the `memberships` map declaration ABOVE `tableFor` so the hooks can reference `membershipFor`. (Reorder: declare `memberships` + `membershipFor` first, then `tableFor`.)

- [ ] **Step 3: Make the message handler async; persist on commit (with `onCommit` claim) and on seat changes**

In `server.ts`, change `ws.on("message", (data) => {` to `ws.on("message", async (data) => {`.

Replace the `submit` case (lines 130-144) with:
```ts
        case "submit": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const t = tableFor(msg.campaignId);
          if (t === null) { send({ t: "denied", reason: "unknown campaign" }); break; }
          const m = membershipFor(msg.campaignId);
          const command = msg.command as Command;
          const actor = actorOf(command);
          if (!m.mayAct(identity, actor)) { send({ t: "denied", reason: "not authorized for this seat" }); break; }
          const claimerId = identity;
          // For a join, claim the seat as `onCommit` so it is written in the SAME
          // atomic persist as the commit (closes the orphaned-character window).
          const onCommit =
            actor.kind === "join" ? () => m.claim(actor.characterId, claimerId) : undefined;
          const result = await t.submit(command, send, onCommit);
          if (actor.kind === "join" && result.committed) broadcastPresence(msg.campaignId);
          break;
        }
```

Replace the seat-control case (lines 145-156) with a persist + revert-on-failure:
```ts
        case "assignSeat":
        case "unassignSeat":
        case "transferGM": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const m = membershipFor(msg.campaignId);
          if (identity !== m.gmIdentity) { send({ t: "denied", reason: "GM only" }); break; }
          if (msg.t === "assignSeat") m.assign(msg.characterId, msg.identity);
          else if (msg.t === "unassignSeat") m.unassign(msg.characterId);
          else m.transferGM(msg.identity);
          const t = tables.get(msg.campaignId);
          if (t !== undefined) {
            try { await t.persist(); }
            catch { await t.reload(); send({ t: "denied", reason: "could not persist; retry" }); break; }
          }
          broadcastPresence(msg.campaignId);
          break;
        }
```

(The `join`, `getSnapshot`, and `close` handlers are unchanged in this task — they still call the synchronous `tableFor`/`tables.get`. The handler being `async` does not change their `break`/`return` semantics.)

- [ ] **Step 4: Wire a `SqliteStore` into the dev harness**

Replace `packages/server/src/main.ts` with:
```ts
import { createServer } from "./server.js";
import { SqliteStore } from "./sqlite-store.js";
import { buildSeedRegistry, demoGenesis } from "@wickedways/seed";

const port = Number(process.env.PORT ?? 8787);
const registry = buildSeedRegistry();
const dbPath = process.env.DB_PATH; // unset ⇒ ephemeral (today's behavior)
const store = dbPath === undefined ? undefined : new SqliteStore(dbPath);
void createServer({
  port,
  verifyToken: (t) => t || null,
  gmIdentityFor: (_id) => process.env.GM_IDENTITY ?? "gm",
  registry,
  genesisFor: (id) => (id === "demo" ? demoGenesis() : null),
  store,
}).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}${store ? ` (persisting to ${dbPath})` : ""}`);
});
```

- [ ] **Step 5: Update `table.test.ts` for async `submit`**

Read `packages/server/src/table.test.ts`. Change every `t.submit(...)` call to `await t.submit(...)` (and make the enclosing test functions `async`). Behavior assertions are unchanged. Add two new tests for the durability hooks:

```ts
it("persists before acking, then broadcasts (flush-before-ack)", async () => {
  const t = table(); // existing helper building a Table from an Authority(demoGenesis())
  const order: string[] = [];
  t.setDurability({ persist: () => { order.push("persist"); return Promise.resolve(); }, reload: () => Promise.resolve() });
  const sender = vi.fn(() => order.push("ack"));
  await t.submit({ kind: "nextPlayer" }, sender);
  expect(order).toEqual(["persist", "ack"]); // persisted before the committed ack
});

it("rolls back and denies when persist fails; head unchanged", async () => {
  const t = table();
  t.setDurability({ persist: () => Promise.reject(new Error("disk full")), reload: () => Promise.resolve() });
  const sender = vi.fn();
  const res = await t.submit({ kind: "nextPlayer" }, sender);
  expect(res).toEqual({ committed: false });
  expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "denied" }));
  expect(t.head()).toBe(0); // no commit acked; reload (no-op here) leaves head at genesis
});
```

- [ ] **Step 6: Update `server.test.ts` for async submit + add a persistence test**

Read `packages/server/src/server.test.ts`. The ws-driven tests already await server round-trips, so most need no change. Where any test calls a `Table` directly, `await` it. Add one persistence test using an in-memory `SqliteStore`:

```ts
import { SqliteStore } from "./sqlite-store.js";

it("persists a campaign record on commit (flush-before-ack)", async () => {
  const { genesis, adaId } = seedFixture(); // existing fixture; gm token "gm" owns no seat
  const store = new SqliteStore(":memory:");
  const server = await createServer({
    port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm",
    registry: buildSeedRegistry(), genesisFor: (id) => (id === "demo" ? genesis : null), store,
  });
  // GM connects and advances the campaign (nextPlayer is a GM command).
  // ... open a ws as "gm", join "demo", submit { kind: "nextPlayer" }, await committed ...
  const rec = await store.load("demo");
  expect(rec?.seq).toBe(1);
  expect(rec?.membership.gmIdentity).toBe("gm");
  await server.close(); store.close();
});
```

Use the suite's existing ws helper to open a connection, `join`, `submit`, and await `committed` (mirror how other tests drive the server). The assertion is that the store holds the committed record.

- [ ] **Step 7: Full checks + commit**

Run: `pnpm checks` → green (existing no-store tests unaffected; new durability tests pass).

```bash
git add packages/server/src/table.ts packages/server/src/server.ts packages/server/src/main.ts packages/server/src/table.test.ts packages/server/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat(server): persist-before-ack write path + rollback

Table.submit is async: persist the full record (snapshot + membership) before
acking/broadcasting; a persist failure reloads the last durable record and denies.
A join's seat-claim runs as onCommit so it lands in the same atomic save as its
commit. Server gains an opt-in `store`; seat changes persist with revert-on-failure.
Server still starts from genesis (resume is the next task).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Server resume on restart + schema gate

Load the persisted record on a campaign's first access and resume from it; fail closed on a schema-version mismatch. Small change to `server.ts` plus the resume tests.

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `CampaignStore.load` (Task 1), `buildAuthority` + durability hooks (Task 5).
- Produces: `ensureLoaded(id): Promise<Table | null>` (async load-or-build), used by `join` and `getSnapshot`.

- [ ] **Step 1: Write the failing resume test**

Add to `packages/server/src/server.test.ts`:

```ts
it("resumes a campaign and its seats across a server restart", async () => {
  const { genesis, adaId } = seedFixture();
  const store = new SqliteStore(":memory:");
  const opts = {
    verifyToken: (t: string) => t || null, gmIdentityFor: () => "gm",
    registry: buildSeedRegistry(), genesisFor: (id: string) => (id === "demo" ? genesis : null), store,
  };
  // First server: GM joins, advances the campaign, assigns Ada's seat to "ident-ada".
  const s1 = await createServer({ port: 0, ...opts });
  // ... ws as "gm": join "demo"; submit { kind:"nextPlayer" } (await committed, seq 1);
  //     assignSeat { characterId: adaId, identity: "ident-ada" } (await presence) ...
  await s1.close();

  // Second server on the SAME store: a fresh getSnapshot resumes at seq 1 with the seat intact.
  const s2 = await createServer({ port: 0, ...opts });
  // ... ws: getSnapshot "demo" -> expect snapshot.seq === 1 ...
  //     ws as "ident-ada": join "demo" -> presence shows Ada's seat owned by "ident-ada" ...
  await s2.close(); store.close();
});
```

Flesh out the ws choreography with the suite's existing helper. Key assertions: `s2`'s `getSnapshot` returns `seq === 1` (resumed, not 0), and presence on `s2` shows `adaId` owned by `ident-ada` (seats survived).

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run packages/server/src/server.test.ts -t "resumes a campaign"`
Expected: FAIL — `s2` starts from genesis (`seq === 0`, no seat) because `tableFor` does not yet load from the store.

- [ ] **Step 3: Load from the store on first access + schema gate**

In `server.ts`, convert `tableFor` into an async `ensureLoaded` that loads the record. Replace the `tableFor` definition (from Task 5) with:

```ts
  const ensureLoaded = async (id: string): Promise<Table | null> => {
    let t = tables.get(id);
    if (t !== undefined) return t;
    const rec = opts.store ? await opts.store.load(id) : null;
    if (rec !== null && !schemaMatches(rec.snapshot)) {
      console.error(`[persistence] campaign ${id}: snapshot schemaVersion ${rec.snapshot.schemaVersion} != current; refusing to resume (migration required)`);
      return null; // fail closed — do NOT build a genesis Table (that would overwrite the record)
    }
    const genesis = rec?.snapshot ?? opts.genesisFor(id);
    if (genesis === null) return null;
    const authority = buildAuthority(id, rec?.seq ?? 0, genesis);
    memberships.set(id, rec ? Membership.fromState(rec.membership) : new Membership(opts.gmIdentityFor(id)));
    t = new Table(authority);
    const store = opts.store;
    if (store !== undefined) {
      t.setDurability({
        persist: () =>
          store.save(id, { seq: t!.head(), snapshot: t!.currentSnapshot(), membership: membershipFor(id).toState() }),
        reload: async () => {
          const r = await store.load(id);
          const fresh = r?.snapshot ?? opts.genesisFor(id);
          if (fresh === null) return;
          t!.replaceAuthority(buildAuthority(id, r?.seq ?? 0, fresh));
          memberships.set(id, r ? Membership.fromState(r.membership) : new Membership(opts.gmIdentityFor(id)));
        },
      });
    }
    tables.set(id, t);
    return t;
  };
```

Add a `schemaMatches` helper using the engine's exported `SCHEMA_VERSION` constant (confirmed at `src/lib/serialization/types.ts:10`, `export const SCHEMA_VERSION = 1`). Add the import near the other `wickedways/lib/...` imports:

```ts
import { SCHEMA_VERSION } from "wickedways/lib/serialization/types";
```
and the helper (module scope, alongside `actorOf`):
```ts
function schemaMatches(snapshot: CampaignSnapshot): boolean {
  return snapshot.schemaVersion === SCHEMA_VERSION;
}
```
(Defense in depth: `deserializeCampaign` itself also throws on a mismatched `schemaVersion` — `deserializer.ts:75` — but the explicit pre-build `schemaMatches` check is what lets `ensureLoaded` fail closed *without* falling back to genesis and clobbering the unmigrated record.)

- [ ] **Step 4: Make `join` and `getSnapshot` await `ensureLoaded`**

In `server.ts`, the `join` case: change `const t = tableFor(msg.campaignId);` to `const t = await ensureLoaded(msg.campaignId);` (the handler is already `async` from Task 5).

The `getSnapshot` case: change `const t = tableFor(msg.campaignId);` to `const t = await ensureLoaded(msg.campaignId);`.

The `submit` and seat-control cases keep using the **synchronous** `tables.get(msg.campaignId)` (the table is guaranteed loaded because a client must `join` first). Update the `submit` case's `const t = tableFor(...)` to `const t = tables.get(msg.campaignId);` and the `tableFor === null` guard to `t === undefined`. `broadcastPresence` keeps `tables.get(campaignId)?.broadcast(...)`.

- [ ] **Step 5: Run the resume test — verify it passes**

Run: `pnpm vitest run packages/server/src/server.test.ts`
Expected: PASS — `s2` resumes at `seq 1` with Ada's seat intact, plus all existing tests.

- [ ] **Step 6: Add the schema-mismatch test**

```ts
it("fails closed when a persisted snapshot's schemaVersion does not match", async () => {
  const { genesis } = seedFixture();
  const store = new SqliteStore(":memory:");
  await store.save("demo", { seq: 5, snapshot: { ...genesis, schemaVersion: genesis.schemaVersion + 1 }, membership: { gmIdentity: "gm", seats: [] } });
  const server = await createServer({
    port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm",
    registry: buildSeedRegistry(), genesisFor: (id) => (id === "demo" ? genesis : null), store,
  });
  // ws: getSnapshot "demo" -> snapshot is null/seq 0 (campaign refused; not overwritten).
  expect((await store.load("demo"))?.seq).toBe(5); // record untouched (not clobbered by genesis)
  await server.close(); store.close();
});
```

- [ ] **Step 7: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "$(cat <<'EOF'
feat(server): resume campaigns + seats from the store on restart

ensureLoaded loads the persisted record on a campaign's first access and resumes
the Authority at its committed seq with Membership restored; a schemaVersion
mismatch fails closed (refuses the campaign rather than clobbering it).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Client identity persistence + docs

Persist the client's identity so a reload keeps its seat, and document the feature.

**Files:**
- Modify: `packages/client/src/main.ts`
- Modify: `README.md`

- [ ] **Step 1: Persist the client identity**

In `packages/client/src/main.ts`, replace line 10 (`const clientId = crypto.randomUUID();`) with:

```ts
const IDENTITY_KEY = "wickedways:identity";
let clientId = localStorage.getItem(IDENTITY_KEY);
if (clientId === null) {
  clientId = crypto.randomUUID();
  localStorage.setItem(IDENTITY_KEY, clientId);
}
```

A reload now reuses the stored identity (so the durable server-side seat is retained). Real deployments source the token from an auth flow; this is the dev-harness behavior.

- [ ] **Step 2: Verify the client builds**

Run: `pnpm --filter @wickedways/client run typecheck`
Expected: green.

- [ ] **Step 3: Document durable persistence in the README**

Read the README's multiplayer / comms section (the authoritative-server subsection added previously). Add a "Durable persistence" subsection covering, in the README's existing tone:
- The server persists each campaign's full snapshot + seat ownership on every commit, **flush-before-ack**, via a host-injected `CampaignStore` (default reference adapter: `SqliteStore` over `node:sqlite`, WAL, atomic per-`save`); a restart resumes at the persisted seq with seats intact.
- Persistence is **opt-in** — no `store` ⇒ ephemeral (the default).
- The client persists its identity in `localStorage` so a reload keeps its seat.
- Node ≥ 22.5 is required when using `SqliteStore`.
- Deferred (note honestly): client state caching (warm-start / offline read); a WAL persistence adapter; multi-instance locking; schema migrations (v1 fails closed on a version mismatch).

- [ ] **Step 4: Full checks + commit**

Run: `pnpm checks` → green.

```bash
git add packages/client/src/main.ts README.md
git commit -m "$(cat <<'EOF'
feat(client): persist identity in localStorage; docs for durable persistence

A reload reuses the stored identity so the durable server-side seat is kept.
README documents the CampaignStore/SqliteStore durability layer (opt-in,
flush-before-ack, resume-on-restart) and the deferred follow-ups.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** store port §`CampaignStore` → Task 1; `startSeq` §"Authority seq-continuity" → Task 2; `Membership` §persistence → Task 3; `SqliteStore` §reference adapter + Node floor + warning suppression → Task 4; server write path / persist-before-ack / rollback / seat-change persistence / atomic-join-claim §"Server wiring" + §"Crash consistency" → Task 5; resume-on-restart + schema-fail-closed §"Server wiring" + §"Schema versioning" → Task 6; client identity §"Client identity persistence" + docs → Task 7. Opt-in/back-compat §"Backward compatibility" is honored throughout (no-store path unchanged).
- **Out of scope honored:** no client state cache, no WAL adapter, no migrations, no multi-instance locking, single-player untouched.
- **Type consistency:** `CampaignRecord`/`MembershipState`/`CampaignStore` (Task 1) are consumed verbatim by Tasks 3–6; `Authority` `startSeq` (Task 2) is used by `buildAuthority` (Tasks 5–6); `Table.submit` is async from Task 5 onward (callers `await`); the durability hooks (`persist`/`reload`) read through the live `Table` so `reload`'s authority swap is transparent.
- **No red window:** every task is additive or opt-in; the no-store path preserves today's behavior, so the full suite stays green each task.
- **One lookup the implementer must resolve:** the engine's current schema-version constant (Task 6, Step 3) — locate it in `src/lib/serialization/` and import it; the fallback is to compare against a freshly-built genesis snapshot's `schemaVersion`.
