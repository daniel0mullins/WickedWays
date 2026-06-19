# Authoritative Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the room server the sole authority over campaign state — it runs the engine to re-derive each delta from the submitted command — so a hostile authenticated seat-holder can no longer forge a delta acting as another seat.

**Architecture:** Resolution (authorize → apply → diff) is extracted from `SyncCoordinator` into a new engine-side `Authority` unit that holds the campaign, the committed log, and the checkpoint. The in-process transport hosts an in-process `Authority`; the WebSocket server hosts the same one. Clients become pure replicas: they `submit(command)` and apply the authoritative delta the server returns (wait-for-authority — no optimistic prediction). The `actor` envelope and client `putSnapshot` are removed; the server derives the actor from the command and snapshots its own state.

**Tech Stack:** TypeScript (strict, `NodeNext`), pnpm workspaces, vitest, `ws`. Engine at repo root (`wickedways`); packages under `packages/*` (`@wickedways/transport-shared`, `@wickedways/server`, `@wickedways/client`, and a new `@wickedways/seed`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-19-authoritative-server-design.md`. Every task implements part of it; re-read the relevant section before starting a task.
- **No rng change.** `rng` stays re-injected/non-serialized. The server's `Authority` draws from its own injected rng. Deterministic-rng + client prediction is explicitly out of scope (a later spec).
- **Server stays free of game-rule logic of its own.** It calls the engine's `Authority`/`commandActorId`/`isJoinCommand` — it must not re-implement authorization or delta logic. The only server-side gate it owns is seat ownership (`Membership.mayAct`), unchanged from 3b.
- **Naming:** the server-side per-campaign coordinator class stays named `Table` (not `Room` — avoids colliding with the engine's game-location `Room`).
- **Branded IDs / symbol seams / `ProceduralViolation`:** unchanged conventions (see `CLAUDE.md`). Do not cast raw strings to branded ids; illegal transitions throw `ProceduralViolation`.
- **Staged red window (READ THIS):** this refactor flips a cross-package interface, so the workspace cannot stay fully green between Tasks 3–5. Each of those tasks lists an explicit **Checks** command scoped to the packages it has flipped, and names the later task that restores full green. Tasks 1, 2, 5, and 6 end fully green (`pnpm checks`). A reviewer seeing a *documented* scoped-red intermediate task should treat it as expected, not a defect.
- **Commits:** end every commit message with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit only at the end of each task (the plan's commit steps). Do not push or open a PR unless the user asks.
- **`pnpm -r run` excludes the root engine project.** Full verification is `pnpm run lint && pnpm run typecheck && pnpm -r run typecheck && pnpm run test` (this is the root `checks` script). `pnpm run test` (`vitest run`) runs the ENTIRE suite including every package's tests.

---

## File Structure

- `src/lib/sync/authority.ts` — **new.** The `Authority` unit: holds a live `Campaign` + committed log + checkpoint; turns a command into `{seq, delta}` or a denial. Owns the rng.
- `src/lib/sync/transport.ts` — **modify.** `SyncTransport` interface: `append`→`submit`, drop `putSnapshot`; `InProcessTransport` rewritten to wrap an `Authority`; `AppendResult`→`SubmitResult`.
- `src/lib/sync/coordinator.ts` — **modify.** Drop `Resolver`/`DeltaComputer`/optimistic-apply/`#restore`/conflict-retry. `submit` forwards to the transport; state applies via the subscription.
- `src/lib/sync/types.ts` — **modify.** `CommandResult` loses `conflict`; add `SubmitResult`.
- `packages/seed/*` — **new package** `@wickedways/seed`: the demo campaign + registry (moved out of the client) plus a `demoGenesis()` helper, importable by both client and server.
- `packages/transport-shared/src/index.ts` — **modify.** Wire protocol: `append`→`submit{command}`, `appendOk`→`committed{seq,delta}`, remove `appendConflict` + `putSnapshot`; drop the `actor` field (keep the `Actor` type for `Membership`).
- `packages/server/src/{table,server,main}.ts` — **modify.** `Table` wraps an `Authority`; `createServer` gains `registry` + `genesisFor` (+ optional `rng`); `submit` handler derives the actor from the command and calls `Authority.submit`. New engine dependency.
- `packages/client/src/{websocket-transport,main}.ts` — **modify.** `submit` instead of `append`; handle `committed`; drop `appendConflict`/`putSnapshot`/`#actorFor`. Client is always a replica (`SyncCoordinator.join`).

---

### Task 1: `Authority` engine unit

Additive — a new engine file with no consumers yet. Workspace stays fully green.

**Files:**
- Create: `src/lib/sync/authority.ts`
- Create: `src/lib/sync/authority.test.ts`
- Modify: `src/lib/sync/types.ts` (add `SubmitResult`)

**Interfaces:**
- Consumes: `Resolver.authorize/apply` (`src/lib/sync/resolver.ts`), `DeltaComputer.diff` (`delta-computer.ts`), `EntityIndex` (`entity-index.ts`), `serializeCampaign`/`serializeCampaignWithIndex` (`../serialization/serializer`), `deserializeCampaign` (`../serialization/deserializer`), `Command`/`LogEntry`/`Delta` (`./types`), `CampaignRegistry` (`../serialization/registry`), `CampaignSnapshot` (`../serialization/types`), `ProceduralViolation` (`../util`).
- Produces:
  ```ts
  // types.ts
  export type SubmitResult =
    | { ok: true; seq: number; delta: Delta }
    | { ok: false; denied: true; reason: string };

  // authority.ts
  export class Authority {
    constructor(genesis: CampaignSnapshot, opts: { registry: CampaignRegistry; rng?: () => number; snapshotEvery?: number });
    submit(command: Command): SubmitResult;   // synchronous
    head(): number;
    loadSnapshot(): { seq: number; snapshot: CampaignSnapshot };
    entriesSince(fromSeq: number): LogEntry[];
  }
  ```

- [ ] **Step 1: Add `SubmitResult` to `types.ts`**

In `src/lib/sync/types.ts`, immediately after the `CommandResult` type (currently lines 74-78), add:

```ts
/** A transport/authority verdict: committed with its delta, or a terminal denial. */
export type SubmitResult =
  | { ok: true; seq: number; delta: Delta }
  | { ok: false; denied: true; reason: string };
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/sync/authority.test.ts`. This reuses the engine's `buildStartedCampaign` test helper if present; otherwise build a minimal started campaign inline. First inspect `src/test-utils.ts` for an existing started-campaign helper and use it. The test below assumes a helper `buildStartedCampaign()` returning `{ campaign, registry }`; if the helper differs, adapt the construction but keep the assertions.

```ts
import { describe, it, expect } from "vitest";
import { Authority } from "./authority";
import { serializeCampaign } from "../serialization/serializer";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";

describe("Authority", () => {
  it("commits a legal command and returns a seq + delta", () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    expect(authority.head()).toBe(0);
    const res = authority.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.seq).toBe(1);
      expect(res.delta).toBeDefined();
    }
    expect(authority.head()).toBe(1);
    expect(authority.entriesSince(1)).toHaveLength(1);
  });

  it("denies an unauthorized command without advancing head", () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    // A turn-action by a non-active character is rejected by Resolver.authorize.
    const res = authority.submit({ kind: "move", actorId: "not-a-real-id" as never, roomId: "nowhere" as never });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/turn|begun|active/i);
    expect(authority.head()).toBe(0);
  });

  it("restores state when apply throws ProceduralViolation (no half-mutation, head unchanged)", () => {
    const { campaign, registry } = buildStartedCampaign();
    const genesis = serializeCampaign(campaign);
    const authority = new Authority(genesis, { registry, rng: () => 0.5 });
    // Construct a command that passes authorize but throws in apply: a `use` of an
    // item the active actor does not hold (Resolver.apply throws ProceduralViolation).
    const active = campaign.activeCharacter;
    const res = authority.submit({ kind: "use", actorId: active.id, itemId: "ghost-item" as never });
    expect(res.ok).toBe(false);
    expect(authority.head()).toBe(0);
    // Snapshot still equals genesis (state intact).
    expect(authority.loadSnapshot()).toEqual({ seq: 0, snapshot: genesis });
  });

  it("checkpoints every `snapshotEvery` commits", () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5, snapshotEvery: 2 });
    authority.submit({ kind: "nextPlayer" });
    expect(authority.loadSnapshot().seq).toBe(0); // not yet
    authority.submit({ kind: "nextPlayer" });
    expect(authority.loadSnapshot().seq).toBe(2); // checkpoint taken at seq 2
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/sync/authority.test.ts`
Expected: FAIL — `Cannot find module './authority'`.

- [ ] **Step 4: Implement `Authority`**

Create `src/lib/sync/authority.ts`:

```ts
import { Campaign } from "../campaign";
import { ProceduralViolation } from "../util";
import { serializeCampaign, serializeCampaignWithIndex } from "../serialization/serializer";
import { deserializeCampaign } from "../serialization/deserializer";
import { EntityIndex } from "./entity-index";
import { Resolver } from "./resolver";
import { DeltaComputer } from "./delta-computer";
import type { CampaignRegistry } from "../serialization/registry";
import type { CampaignSnapshot } from "../serialization/types";
import type { Command, LogEntry, SubmitResult } from "./types";

/**
 * The single authority over a campaign's state. Holds the live {@link Campaign},
 * the committed ordered log, and the latest checkpoint. {@link Authority.submit}
 * authorizes, applies, diffs, and commits a command — re-deriving the delta from
 * the command itself, so callers never supply a delta. Used both in-process
 * (single-player, behind {@link InProcessTransport}) and on the room server
 * (multiplayer): the same authority, two host sites.
 */
export class Authority {
  #campaign: Campaign;
  #log: LogEntry[] = [];
  #snapshot: { seq: number; snapshot: CampaignSnapshot };
  readonly #registry: CampaignRegistry;
  readonly #rng: () => number;
  readonly #snapshotEvery: number;
  readonly #resolver = new Resolver();
  readonly #deltaComputer = new DeltaComputer();

  constructor(
    genesis: CampaignSnapshot,
    opts: { registry: CampaignRegistry; rng?: () => number; snapshotEvery?: number },
  ) {
    this.#registry = opts.registry;
    this.#rng = opts.rng ?? Math.random;
    this.#snapshotEvery = opts.snapshotEvery ?? 20;
    this.#campaign = deserializeCampaign(genesis, { registry: this.#registry, rng: this.#rng });
    this.#snapshot = { seq: 0, snapshot: genesis };
  }

  /** Highest committed seq (0 when empty). */
  head(): number {
    const last = this.#log[this.#log.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  /** The latest checkpoint (the genesis snapshot until the first `snapshotEvery` commit). */
  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } {
    return this.#snapshot;
  }

  /** Committed entries with `seq >= fromSeq`, in order. */
  entriesSince(fromSeq: number): LogEntry[] {
    return this.#log.filter((e) => e.seq >= fromSeq);
  }

  /**
   * Authorize → apply (restoring from the pre-call snapshot on a
   * {@link ProceduralViolation}) → diff → commit. Returns the committed
   * `{ seq, delta }` or a terminal denial; the authoritative state is never left
   * half-mutated.
   */
  submit(command: Command): SubmitResult {
    const auth = this.#resolver.authorize(this.#campaign, command);
    if (!auth.ok) return { ok: false, denied: true, reason: auth.reason };

    const { snapshot: before, index: rawIndex } = serializeCampaignWithIndex(this.#campaign);
    try {
      this.#resolver.apply(this.#campaign, command, new EntityIndex(rawIndex));
    } catch (e) {
      if (e instanceof ProceduralViolation) {
        this.#campaign = deserializeCampaign(before, { registry: this.#registry, rng: this.#rng });
        return { ok: false, denied: true, reason: e.message };
      }
      throw e;
    }

    const after = serializeCampaign(this.#campaign);
    const delta = this.#deltaComputer.diff(before, after);
    const seq = this.head() + 1;
    this.#log.push({ seq, baseSeq: seq - 1, command, delta });
    if (seq % this.#snapshotEvery === 0) this.#snapshot = { seq, snapshot: after };
    return { ok: true, seq, delta };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/sync/authority.test.ts`
Expected: PASS (4 tests). If the `use`/`move` denial reasons differ, adjust the regex/ids to match the real `Resolver` (read `src/lib/sync/resolver.ts`), keeping the head-unchanged and snapshot-intact assertions.

- [ ] **Step 6: Full checks + commit**

Run: `pnpm checks`
Expected: all green (this task is purely additive).

```bash
git add src/lib/sync/authority.ts src/lib/sync/authority.test.ts src/lib/sync/types.ts
git commit -m "$(cat <<'EOF'
feat(sync): Authority unit — authoritative resolve/apply/diff/commit

Extracts the resolve→apply→diff→commit orchestration into a single engine-side
Authority that holds the campaign, the committed log, and the checkpoint, and
owns the rng. No consumers yet; SyncCoordinator and the server adopt it next.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `@wickedways/seed` shared package

Additive — moves the demo campaign/registry out of the client into a package both client and server import. The client keeps working; the workspace stays fully green. This unblocks the server (Task 4), which needs a genesis snapshot + the matching registry.

**Files:**
- Create: `packages/seed/package.json`, `packages/seed/tsconfig.json`, `packages/seed/src/index.ts`
- Modify: `packages/client/src/seed.ts` (delete its body; re-export from the new package) — see Step 4
- Modify: `packages/client/package.json` (add `@wickedways/seed` dependency)
- Modify: `packages/client/src/main.ts` and `packages/client/src/*.test.ts` imports only if they import from `./seed` (keep `./seed` re-exporting, so no import churn is required)

**Interfaces:**
- Produces (from `@wickedways/seed`):
  ```ts
  export function buildSeedRegistry(): CampaignRegistry;
  export function buildSeedCampaign(): { campaign: Campaign; registry: CampaignRegistry };
  /** The demo campaign serialized to a genesis snapshot (what the server's Authority is built from). */
  export function demoGenesis(): CampaignSnapshot;
  ```

- [ ] **Step 1: Create the package manifest**

Create `packages/seed/package.json`:

```json
{
  "name": "@wickedways/seed",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "wickedways": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.10.0"
  }
}
```

Create `packages/seed/tsconfig.json` by copying `packages/client/tsconfig.json` verbatim (same compiler options; it already resolves `wickedways/lib/*`). Read `packages/client/tsconfig.json` first and mirror it exactly.

- [ ] **Step 2: Move the seed source**

Create `packages/seed/src/index.ts` with the **exact current contents** of `packages/client/src/seed.ts` (read it now and copy it), then append the `demoGenesis` helper and its import:

```ts
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

/** The demo campaign serialized to a genesis snapshot — the server's Authority is built from this. */
export function demoGenesis(): CampaignSnapshot {
  return serializeCampaign(buildSeedCampaign().campaign);
}
```

(Place the `import` lines at the top alongside the existing imports, and the function at the bottom.)

- [ ] **Step 3: Add the dependency to the client**

In `packages/client/package.json`, add to `dependencies`:

```json
    "@wickedways/seed": "workspace:*",
```

Run: `pnpm install`
Expected: links the new workspace package; no errors.

- [ ] **Step 4: Re-export from the client's `seed.ts`**

Replace the entire body of `packages/client/src/seed.ts` with a re-export, so existing client imports (`./seed`) keep resolving unchanged:

```ts
/** Re-export of the shared demo seed (moved to `@wickedways/seed`). */
export { buildSeedRegistry, buildSeedCampaign, demoGenesis } from "@wickedways/seed";
```

Check `packages/client/src/seed.test.ts`: if it imports from `./seed`, it still works via the re-export. If it asserts on internals no longer present, point its imports at `@wickedways/seed` and keep the assertions.

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks`
Expected: all green (behavior unchanged; the client now sources the seed from the shared package).

```bash
git add packages/seed packages/client/package.json packages/client/src/seed.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
refactor(seed): extract @wickedways/seed shared package

Moves the demo campaign + registry out of the client so the authoritative
server (next) can build its Authority from the same genesis snapshot and the
same registry the clients hydrate with. Client re-exports for import stability.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Flip the engine sync core to the Authority

Replace the client-resolves coordinator/transport with the wait-for-authority model. **This task ends ENGINE-green but leaves `@wickedways/client` red** (its `WebSocketTransport` implements the old `SyncTransport`); `@wickedways/server` and `@wickedways/transport-shared` remain green (they don't depend on the engine's `SyncTransport`). Full green returns in **Task 5**.

**Files:**
- Modify: `src/lib/sync/transport.ts`
- Modify: `src/lib/sync/coordinator.ts`
- Modify: `src/lib/sync/types.ts` (`CommandResult` loses `conflict`)
- Modify: `src/lib/sync/transport.test.ts`, `src/lib/sync/coordinator.test.ts`, `src/integration.test.ts`

**Interfaces:**
- Consumes: `Authority` (Task 1), `SubmitResult` (Task 1).
- Produces:
  ```ts
  export interface SyncTransport {
    head(): number;
    submit(command: Command): Promise<SubmitResult>;
    entriesSince(fromSeq: number): LogEntry[];
    subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void;
    loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } | null;
  }
  export class InProcessTransport implements SyncTransport { constructor(authority: Authority); /* ...interface */ }
  // SyncCoordinator: unchanged public surface — `static join(...)`, `get campaign`, `start()`, `stop()`, `submit(command): Promise<CommandResult>`.
  ```

- [ ] **Step 1: Drop `conflict` from `CommandResult`**

In `src/lib/sync/types.ts`, change `CommandResult` (currently lines 74-78) to:

```ts
/** The outcome of submitting a command: committed with its delta, or a terminal rejection. */
export type CommandResult =
  | { ok: true; seq: number; delta: Delta }
  | { ok: false; rejected: true; reason: string };
```

- [ ] **Step 2: Rewrite `transport.ts` (interface + `InProcessTransport`)**

Replace the entire contents of `src/lib/sync/transport.ts` with:

```ts
import { Authority } from "./authority";
import type { Command, LogEntry, SubmitResult } from "./types";
import type { CampaignSnapshot } from "../serialization/types";

export type { SubmitResult } from "./types";

/**
 * The ordered, broadcast surface the {@link SyncCoordinator} submits commands to
 * and reads entries from. The in-process implementation wraps an {@link Authority}
 * directly; the WebSocket implementation forwards to the room server. Only this
 * interface and the coordinator need know the difference.
 */
export interface SyncTransport {
  /** Highest committed seq (0 when empty). */
  head(): number;
  /** Submit a command to the authority; resolves with the committed delta or a denial. */
  submit(command: Command): Promise<SubmitResult>;
  /** Entries with `seq >= fromSeq`, in order. */
  entriesSince(fromSeq: number): LogEntry[];
  /** Replays from `fromSeq`, then streams new entries; returns an unsubscribe thunk. */
  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void;
  /** The latest checkpoint, or null if none is known yet. */
  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } | null;
}

/** In-process {@link SyncTransport}: wraps an {@link Authority} and fans committed entries out to subscribers. */
export class InProcessTransport implements SyncTransport {
  readonly #authority: Authority;
  #subscribers = new Set<(entry: LogEntry) => void>();

  constructor(authority: Authority) {
    this.#authority = authority;
  }

  head(): number {
    return this.#authority.head();
  }

  submit(command: Command): Promise<SubmitResult> {
    const res = this.#authority.submit(command);
    if (res.ok) {
      const entry: LogEntry = { seq: res.seq, baseSeq: res.seq - 1, command, delta: res.delta };
      for (const handler of this.#subscribers) handler(entry);
    }
    return Promise.resolve(res);
  }

  entriesSince(fromSeq: number): LogEntry[] {
    return this.#authority.entriesSince(fromSeq);
  }

  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void {
    for (const e of this.#authority.entriesSince(fromSeq)) handler(e);
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } {
    return this.#authority.loadSnapshot();
  }
}
```

- [ ] **Step 3: Simplify `coordinator.ts`**

Replace the entire contents of `src/lib/sync/coordinator.ts` with:

```ts
import { Campaign } from "../campaign";
import { ProceduralViolation } from "../util";
import { deserializeCampaign } from "../serialization/deserializer";
import { DeltaApplier } from "./delta-applier";
import type { SyncTransport } from "./transport";
import type { CampaignRegistry } from "../serialization/registry";
import type { Command, CommandResult, LogEntry } from "./types";

/**
 * A replica of a campaign synchronized against an authoritative transport. Submits
 * commands to the authority (in-process or the room server) and applies the
 * authoritative deltas it broadcasts back. The coordinator never resolves commands
 * itself and never optimistically mutates — state changes only when an authoritative
 * delta arrives, so there is no rollback and no CAS conflict.
 *
 * **Swappable campaign reference.** The coordinator owns the local replica; read
 * current state through {@link SyncCoordinator.campaign} and never cache the
 * reference across a {@link SyncCoordinator.submit} call.
 */
export class SyncCoordinator {
  #local: Campaign;
  readonly #registry: CampaignRegistry;
  readonly #transport: SyncTransport;
  readonly #rng: () => number;
  readonly #applier = new DeltaApplier();
  #lastApplied: number;
  #unsubscribe: (() => void) | null = null;

  private constructor(opts: {
    campaign: Campaign;
    registry: CampaignRegistry;
    transport: SyncTransport;
    rng: () => number;
    lastApplied: number;
  }) {
    this.#local = opts.campaign;
    this.#registry = opts.registry;
    this.#transport = opts.transport;
    this.#rng = opts.rng;
    this.#lastApplied = opts.lastApplied;
  }

  /** Builds a replica from the transport's latest snapshot + deltas-since. */
  static join(opts: {
    registry: CampaignRegistry;
    transport: SyncTransport;
    rng?: () => number;
  }): SyncCoordinator {
    const snap = opts.transport.loadSnapshot();
    if (snap === null) {
      throw new ProceduralViolation("Cannot join: transport has no snapshot to load.");
    }
    const rng = opts.rng ?? Math.random;
    const campaign = deserializeCampaign(snap.snapshot, { registry: opts.registry, rng });
    const coordinator = new SyncCoordinator({
      campaign,
      registry: opts.registry,
      transport: opts.transport,
      rng,
      lastApplied: snap.seq,
    });
    coordinator.#syncTo(opts.transport.head());
    return coordinator;
  }

  /** The currently-owned local replica. Never cache it across a {@link SyncCoordinator.submit}. */
  get campaign(): Campaign {
    return this.#local;
  }

  /** Begins applying inbound authoritative entries. */
  start(): void {
    this.#unsubscribe = this.#transport.subscribe(this.#lastApplied + 1, (entry) => this.#onRemote(entry));
  }

  /** Stops applying inbound entries (inverse of {@link SyncCoordinator.start}). */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * Submits a command to the authority. On success the authoritative delta has
   * already been applied to the local replica (via the subscription) by the time
   * this resolves.
   *
   * - `{ ok: true, seq, delta }` — committed.
   * - `{ ok: false, rejected: true, reason }` — the authority denied the command
   *   (auth gate, engine constraint, or a lost connection); the local replica is
   *   untouched and reconverges from the authority's broadcast.
   */
  async submit(command: Command): Promise<CommandResult> {
    const res = await this.#transport.submit(command);
    if (!res.ok) return { ok: false, rejected: true, reason: res.reason };
    if (this.#lastApplied < res.seq) {
      // Defensive: if the subscription has not yet delivered our entry (e.g. the
      // coordinator was never started), fast-forward now so callers see the commit.
      this.#syncTo(this.#transport.head());
    }
    return { ok: true, seq: res.seq, delta: res.delta };
  }

  #onRemote(entry: LogEntry): void {
    if (entry.seq <= this.#lastApplied) return; // already incorporated
    if (entry.seq !== this.#lastApplied + 1) {
      this.#syncTo(this.#transport.head()); // heal a gap
      return;
    }
    this.#applier.apply(this.#local, entry.delta, { registry: this.#registry, rng: this.#rng });
    this.#lastApplied = entry.seq;
  }

  #syncTo(targetHead: number): void {
    for (const entry of this.#transport.entriesSince(this.#lastApplied + 1)) {
      if (entry.seq > targetHead) break;
      if (entry.seq !== this.#lastApplied + 1) continue;
      this.#applier.apply(this.#local, entry.delta, { registry: this.#registry, rng: this.#rng });
      this.#lastApplied = entry.seq;
    }
  }
}
```

> Note: `submit` relies on `#onRemote` having applied the entry synchronously during `await this.#transport.submit(...)` (the in-process transport fans out before resolving; the WS transport applies on `committed` before resolving). The `#syncTo` fallback covers a coordinator that was never `start()`ed.

- [ ] **Step 4: Update `transport.test.ts`**

Read `src/lib/sync/transport.test.ts`. It currently tests `InProcessTransport`'s CAS `append`. Rewrite it against the new constructor + `submit`. Use a real `Authority` built from a started campaign:

```ts
import { describe, it, expect } from "vitest";
import { Authority } from "./authority";
import { InProcessTransport } from "./transport";
import { serializeCampaign } from "../serialization/serializer";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";

describe("InProcessTransport", () => {
  function setup() {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    return new InProcessTransport(authority);
  }

  it("commits a submitted command and exposes it via head/entriesSince", async () => {
    const t = setup();
    expect(t.head()).toBe(0);
    const res = await t.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    expect(t.head()).toBe(1);
    expect(t.entriesSince(1)).toHaveLength(1);
  });

  it("fans a committed entry out to subscribers", async () => {
    const t = setup();
    const seen: number[] = [];
    t.subscribe(1, (e) => seen.push(e.seq));
    await t.submit({ kind: "nextPlayer" });
    expect(seen).toEqual([1]);
  });

  it("returns a denial without committing", async () => {
    const t = setup();
    const res = await t.submit({ kind: "move", actorId: "nobody" as never, roomId: "nowhere" as never });
    expect(res.ok).toBe(false);
    expect(t.head()).toBe(0);
  });
});
```

Run: `pnpm vitest run src/lib/sync/transport.test.ts` → PASS.

- [ ] **Step 5: Update `coordinator.test.ts`**

Read `src/lib/sync/coordinator.test.ts`. Replace every coordinator/transport construction with the Authority-backed wiring, and delete tests that asserted the removed behavior (optimistic local apply before append, CAS-conflict retry/`conflict` result, `#restore` after rejection). Keep/port: a legal `submit` converges the replica; an illegal `submit` returns `{ rejected, reason }` and leaves the replica unchanged; `join` reconstructs a replica and catches up; two coordinators on one transport converge. Standard wiring helper to use throughout:

```ts
import { Authority } from "./authority";
import { InProcessTransport } from "./transport";
import { SyncCoordinator } from "./coordinator";
import { serializeCampaign } from "../serialization/serializer";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";

function wire() {
  const { campaign, registry } = buildStartedCampaign();
  const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
  const transport = new InProcessTransport(authority);
  const coordinator = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
  coordinator.start();
  return { registry, transport, coordinator };
}
```

Representative ported tests:

```ts
it("applies a legal command to the replica", async () => {
  const { coordinator } = wire();
  const before = coordinator.campaign.activeCharacter.id;
  const res = await coordinator.submit({ kind: "nextPlayer" });
  expect(res.ok).toBe(true);
  expect(coordinator.campaign.activeCharacter.id).not.toBe(before);
});

it("rejects an illegal command and leaves the replica unchanged", async () => {
  const { coordinator } = wire();
  const before = serializeCampaign(coordinator.campaign);
  const res = await coordinator.submit({ kind: "move", actorId: "nobody" as never, roomId: "nowhere" as never });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.rejected).toBe(true);
  expect(serializeCampaign(coordinator.campaign)).toEqual(before);
});

it("two replicas on one transport converge", async () => {
  const { registry, transport, coordinator: a } = wire();
  const b = SyncCoordinator.join({ registry, transport, rng: () => 0.5 });
  b.start();
  await a.submit({ kind: "nextPlayer" });
  expect(serializeCampaign(b.campaign)).toEqual(serializeCampaign(a.campaign));
});
```

Run: `pnpm vitest run src/lib/sync/coordinator.test.ts` → PASS.

- [ ] **Step 6: Update `integration.test.ts`**

Read `src/integration.test.ts`. Replace each `new SyncCoordinator({ campaign, ... })` / `new InProcessTransport()` / `SyncCoordinator.join(...)` site with the Authority-backed `wire()` shape from Step 5 (build an `Authority` from `serializeCampaign(campaign)`, wrap in `InProcessTransport`, `SyncCoordinator.join`). Any assertion on `conflict` results is removed (no CAS now); a command that is illegal against the current authoritative state simply returns `{ rejected, reason }`. Preserve all convergence assertions.

Run: `pnpm vitest run src/integration.test.ts` → PASS.

- [ ] **Step 7: Engine-scoped checks + commit**

This task intentionally leaves `@wickedways/client` red (restored in Task 5). Verify the engine is green and the non-client packages still typecheck:

Run: `pnpm run lint && pnpm run typecheck && pnpm vitest run src/ && pnpm --filter @wickedways/transport-shared --filter @wickedways/server run typecheck`
Expected: green. (Do NOT run full `pnpm checks` — `@wickedways/client` typecheck and its tests will fail by design until Task 5.)

```bash
git add src/lib/sync/transport.ts src/lib/sync/coordinator.ts src/lib/sync/types.ts src/lib/sync/transport.test.ts src/lib/sync/coordinator.test.ts src/integration.test.ts
git commit -m "$(cat <<'EOF'
refactor(sync): coordinator/transport flip to wait-for-authority

InProcessTransport now wraps an Authority; SyncCoordinator is a pure replica that
submits commands and applies authoritative deltas — optimistic apply, #restore,
and CAS-conflict retry removed. CommandResult loses its conflict variant. Engine
is green; @wickedways/client is intentionally red until the network flip lands.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire protocol + authoritative server

Flip the wire protocol and make the server run the engine. **Ends with the engine + `@wickedways/transport-shared` + `@wickedways/server` green; `@wickedways/client` is still red** (its transport speaks the old wire). Full green returns in **Task 5**.

**Files:**
- Modify: `packages/transport-shared/src/index.ts`, `packages/transport-shared/src/index.test.ts`
- Modify: `packages/server/src/table.ts`, `packages/server/src/server.ts`, `packages/server/src/main.ts`
- Modify: `packages/server/src/table.test.ts`, `packages/server/src/server.test.ts`
- Modify: `packages/server/package.json` (add `wickedways` + `@wickedways/seed` deps)

**Interfaces:**
- Consumes: `Authority` + `SubmitResult` (Tasks 1/3), `demoGenesis`/`buildSeedRegistry` (Task 2), `commandActorId`/`isJoinCommand`/`Command` (`wickedways/lib/sync/types`), `CampaignRegistry`, `CampaignSnapshot`.
- Produces:
  ```ts
  // transport-shared
  type ClientMsg =
    | { t: "join"; campaignId: string; token: string; fromSeq: number }
    | { t: "submit"; campaignId: string; command: unknown }
    | { t: "getSnapshot"; campaignId: string }
    | { t: "assignSeat"; campaignId: string; characterId: string; identity: string }
    | { t: "unassignSeat"; campaignId: string; characterId: string }
    | { t: "transferGM"; campaignId: string; identity: string };
  type ServerMsg =
    | { t: "joined"; head: number }
    | { t: "entry"; entry: WireLogEntry }
    | { t: "committed"; seq: number; delta: unknown }
    | { t: "snapshot"; seq: number; snapshot: unknown }
    | { t: "denied"; reason: string }
    | { t: "error"; message: string }
    | { t: "presence"; campaignId: string; seats: PresenceEntry[]; gm: { identity: string; online: boolean } };
  // createServer
  interface ServerOptions {
    port?: number;
    verifyToken: (token: string) => Identity | null;
    gmIdentityFor: (campaignId: string) => Identity;
    registry: CampaignRegistry;
    genesisFor: (campaignId: string) => CampaignSnapshot | null;
    rng?: () => number;
  }
  ```

- [ ] **Step 1: Flip the wire protocol**

In `packages/transport-shared/src/index.ts`:

1. In `ClientMsg` (lines 31-38): replace the `append` member with `{ t: "submit"; campaignId: string; command: unknown }` and delete the `putSnapshot` member. Keep `join`, `getSnapshot`, `assignSeat`, `unassignSeat`, `transferGM`.
2. In `ServerMsg` (lines 44-52): replace `{ t: "appendOk"; seq: number }` with `{ t: "committed"; seq: number; delta: unknown }` and delete `{ t: "appendConflict"; head: number }`. Keep the rest.
3. Keep the `Actor` type and `WireLogEntry` (still used by `Membership` and the `entry` broadcast). Delete the now-unused `isActor` helper (lines 67-73).
4. In `parseClientMsg`: replace the `case "append"` with:
   ```ts
   case "submit":
     return typeof raw.campaignId === "string" && "command" in raw
       ? { t: "submit", campaignId: raw.campaignId, command: raw.command }
       : null;
   ```
   and delete the `case "putSnapshot"` block.
5. In `parseServerMsg`: replace `case "appendOk"` with:
   ```ts
   case "committed":
     return typeof raw.seq === "number" && "delta" in raw
       ? { t: "committed", seq: raw.seq, delta: raw.delta }
       : null;
   ```
   and delete the `case "appendConflict"` block.

- [ ] **Step 2: Update `index.test.ts`**

Read `packages/transport-shared/src/index.test.ts`. For every `append`/`appendOk`/`appendConflict`/`putSnapshot` round-trip assertion, replace with the `submit`/`committed` equivalents, and drop the `isActor`/`actor`-field assertions. Add a malformed-message rejection for `submit` (missing `command`) and `committed` (missing `delta`). Example:

```ts
it("round-trips a submit message", () => {
  const msg = { t: "submit", campaignId: "c", command: { kind: "nextPlayer" } };
  expect(parseClientMsg(msg)).toEqual(msg);
});
it("rejects a submit without a command", () => {
  expect(parseClientMsg({ t: "submit", campaignId: "c" })).toBeNull();
});
it("round-trips a committed message", () => {
  const msg = { t: "committed", seq: 3, delta: { changed: [], created: [], removed: [] } };
  expect(parseServerMsg(msg)).toEqual(msg);
});
```

Run: `pnpm --filter @wickedways/transport-shared run typecheck && pnpm vitest run packages/transport-shared` → PASS.

- [ ] **Step 3: Add engine + seed deps to the server**

In `packages/server/package.json`, add to `dependencies`:

```json
    "wickedways": "workspace:*",
    "@wickedways/seed": "workspace:*",
```

Run: `pnpm install` → links; no errors.

- [ ] **Step 4: Rewrite `Table` to wrap an `Authority`**

Replace the entire contents of `packages/server/src/table.ts` with:

```ts
import type { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";

/** A connected participant: receives ordered server messages for one {@link Table}. */
export type Subscriber = (msg: ServerMsg) => void;

/**
 * The server-side coordinator for one campaign's session — the virtual tabletop.
 * Wraps the engine {@link Authority} (the single source of truth) and the
 * participant set, emitting ordered messages through {@link Subscriber} callbacks.
 * The submitter receives `committed{seq,delta}`; every other participant receives
 * `entry{seq,delta}`. Named `Table` (not `Room`) to avoid colliding with the
 * engine's game-location `Room`.
 */
export class Table {
  readonly #authority: Authority;
  #participants = new Set<Subscriber>();

  constructor(authority: Authority) {
    this.#authority = authority;
  }

  /** Highest committed seq (0 when empty). */
  head(): number {
    return this.#authority.head();
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
   * Resolves a command through the authority. On commit: acks `sender` with
   * `committed{seq,delta}` and broadcasts `entry{seq,delta}` to every OTHER
   * participant. On denial: replies `denied{reason}` to `sender` only.
   */
  submit(command: Command, sender: Subscriber): { committed: true; seq: number } | { committed: false } {
    const res = this.#authority.submit(command);
    if (!res.ok) {
      sender({ t: "denied", reason: res.reason });
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

- [ ] **Step 5: Make `createServer` authoritative**

Edit `packages/server/src/server.ts`:

1. Imports — add:
   ```ts
   import { Authority } from "wickedways/lib/sync/authority";
   import { commandActorId, isJoinCommand, type Command } from "wickedways/lib/sync/types";
   import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
   import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
   import type { Actor } from "@wickedways/transport-shared";
   ```
2. `ServerOptions` — add the three host-injected fields:
   ```ts
   /** Host-built registry, identical to the clients' (the Authority hydrates with it). */
   registry: CampaignRegistry;
   /** Host-supplied genesis for a campaign, or null to reject it as unknown. */
   genesisFor: (campaignId: string) => CampaignSnapshot | null;
   /** Optional rng for every campaign's Authority (defaults to Math.random). */
   rng?: () => number;
   ```
3. Replace `tableFor` so it lazily builds a `Table` from an `Authority`, returning `null` for an unknown campaign:
   ```ts
   const tableFor = (id: string): Table | null => {
     let t = tables.get(id);
     if (t === undefined) {
       const genesis = opts.genesisFor(id);
       if (genesis === null) return null;
       const authority = new Authority(genesis, { registry: opts.registry, rng: opts.rng });
       t = new Table(authority);
       tables.set(id, t);
     }
     return t;
   };
   ```
   `broadcastPresence` calls `tableFor(campaignId)` — guard the null: `tableFor(campaignId)?.broadcast(presenceOf(campaignId));`.
4. Add the actor-from-command helper (module scope, above `createServer` or just inside it):
   ```ts
   /** Derives the seat an append acts as, read straight from the command (no client-supplied envelope). */
   function actorOf(command: Command): Actor {
     if (isJoinCommand(command)) return { kind: "join", characterId: command.character.id };
     const actorId = commandActorId(command);
     return actorId === null ? { kind: "gm" } : { kind: "character", actorId };
   }
   ```
5. In the `join` case (currently ~line 95): guard the unknown campaign before joining:
   ```ts
   case "join": {
     const id = verify(msg.token);
     if (id === null) { send({ t: "denied", reason: "authentication failed" }); return; }
     if (identity !== null && id !== identity) { send({ t: "denied", reason: "different identity on one connection" }); break; }
     if (joined.has(msg.campaignId)) { send({ t: "denied", reason: "already joined this campaign" }); break; }
     const t = tableFor(msg.campaignId);
     if (t === null) { send({ t: "denied", reason: "unknown campaign" }); break; }
     identity = id;
     t.join(send, msg.fromSeq);
     joined.add(msg.campaignId);
     bump(msg.campaignId, id, 1);
     broadcastPresence(msg.campaignId);
     break;
   }
   ```
6. Replace the entire `case "append"` block with `case "submit"`:
   ```ts
   case "submit": {
     if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
     const t = tableFor(msg.campaignId);
     if (t === null) { send({ t: "denied", reason: "unknown campaign" }); break; }
     const m = membershipFor(msg.campaignId);
     const command = msg.command as Command;
     const actor = actorOf(command);
     if (!m.mayAct(identity, actor)) { send({ t: "denied", reason: "not authorized for this seat" }); break; }
     const result = t.submit(command, send);
     if (actor.kind === "join" && result.committed) {
       m.claim(actor.characterId, identity); // self-service seat claim, on commit
       broadcastPresence(msg.campaignId);
     }
     break;
   }
   ```
7. Replace the `getSnapshot` case body with a null-guard:
   ```ts
   case "getSnapshot": {
     const t = tableFor(msg.campaignId);
     if (t === null) { send({ t: "snapshot", seq: 0, snapshot: null }); break; }
     t.sendSnapshot(send); // read-only; pre-auth allowed (unchanged 3b boundary)
     break;
   }
   ```
8. Delete the entire `case "putSnapshot"` block.
9. In `ws.on("close")` the `tables.get(id)?.leave(send)` line is unchanged (still null-safe).

- [ ] **Step 6: Wire the dev harness (`server/main.ts`)**

Replace `packages/server/src/main.ts` with:

```ts
import { createServer } from "./server.js";
import { buildSeedRegistry, demoGenesis } from "@wickedways/seed";

const port = Number(process.env.PORT ?? 8787);
const registry = buildSeedRegistry();
void createServer({
  port,
  verifyToken: (t) => t || null,
  gmIdentityFor: (_id) => process.env.GM_IDENTITY ?? "gm",
  registry,
  genesisFor: (id) => (id === "demo" ? demoGenesis() : null),
}).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}`);
});
```

- [ ] **Step 7: Update `table.test.ts`**

Read `packages/server/src/table.test.ts`. It currently feeds opaque entries through CAS `append`. Rewrite it to construct a `Table` from a real `Authority` and drive real commands:

```ts
import { describe, it, expect, vi } from "vitest";
import { Authority } from "wickedways/lib/sync/authority";
import { Table } from "./table";
import { demoGenesis, buildSeedRegistry } from "@wickedways/seed";

function table() {
  return new Table(new Authority(demoGenesis(), { registry: buildSeedRegistry(), rng: () => 0.5 }));
}

describe("Table", () => {
  it("acks the submitter with committed and broadcasts entry to others", () => {
    const t = table();
    const sender = vi.fn();
    const other = vi.fn();
    t.join(other, 0);
    t.join(sender, 0);
    other.mockClear();
    const res = t.submit({ kind: "nextPlayer" }, sender);
    expect(res).toEqual({ committed: true, seq: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "committed", seq: 1 }));
    expect(other).toHaveBeenCalledWith(expect.objectContaining({ t: "entry" }));
  });

  it("denies an illegal command to the sender only", () => {
    const t = table();
    const sender = vi.fn();
    const res = t.submit({ kind: "move", actorId: "nobody", roomId: "nowhere" } as never, sender);
    expect(res).toEqual({ committed: false });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "denied" }));
    expect(t.head()).toBe(0);
  });
});
```

Run: `pnpm --filter @wickedways/server run typecheck && pnpm vitest run packages/server/src/table.test.ts` → PASS.

- [ ] **Step 8: Update `server.test.ts`**

Read `packages/server/src/server.test.ts` (the large 3b suite). Apply these mechanical changes throughout, preserving every auth/ownership/presence assertion.

**Shared-genesis setup (CRITICAL — character ids are random uuids).** `buildSeedCampaign()` mints fresh uuid character ids on every call, so a test must build the genesis **once** and derive seat ids from that same instance; `deserializeCampaign` preserves ids, so the server's Authority ends up with exactly those seats. Do NOT use `demoGenesis()` in tests that act as a specific seat (it builds a fresh, different-id campaign each call — it is only for the server's `main.ts` harness). Per-test setup:

```ts
import { buildSeedCampaign, buildSeedRegistry } from "@wickedways/seed";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";

function seedFixture() {
  const seed = buildSeedCampaign();
  const genesis = serializeCampaign(seed.campaign);
  const adaId = seed.campaign.activeCharacter.id;                    // active = first PC
  const benId = seed.campaign.party.find((p) => p.id !== adaId)!.id; // the other PC
  return { genesis, adaId, benId };
}
// createServer({ ..., registry: buildSeedRegistry(), genesisFor: (id) => id === "demo" ? genesis : null })
```

- `createServer(...)` calls gain `registry: buildSeedRegistry()` and `genesisFor: (id) => id === "demo" ? genesis : null` (the `genesis` from `seedFixture()`). Switch the test's campaign id to `"demo"`.
- Every raw client `append` frame becomes a `submit` frame carrying a **real `Command`** (e.g. `{ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }`); there is no `entry`/`actor` field. Where a test acts as a specific character, use `adaId`/`benId` from `seedFixture()`.
- Every expected `appendOk` becomes `committed` (`{ t: "committed", seq, delta }`); assert on `t === "committed"` and `seq`, not on the delta contents.
- Delete assertions about `appendConflict` and `putSnapshot` (both removed). The 3b "GM-gated putSnapshot" tests are deleted outright — clients can no longer snapshot.
- The anti-impersonation test (3b) now asserts: a client authenticated as Ben submitting `{ kind: "move", actorId: <Ada's id>, ... }` is `denied` ("not authorized for this seat") and `head` does not advance. Keep the seat-ownership, GM-control (`assignSeat`/`unassignSeat`/`transferGM`), and presence tests, adjusting only the message shapes above.
- Add one new test: an unknown campaign id (no genesis) → `join` is `denied` with `"unknown campaign"`.

Run: `pnpm --filter @wickedways/server run typecheck && pnpm vitest run packages/server` → PASS.

- [ ] **Step 9: Server-scoped checks + commit**

This task intentionally leaves `@wickedways/client` red (restored in Task 5).

Run: `pnpm run lint && pnpm run typecheck && pnpm vitest run src/ packages/transport-shared packages/server && pnpm --filter @wickedways/transport-shared --filter @wickedways/server run typecheck`
Expected: green. (Do NOT run full `pnpm checks`; `@wickedways/client` is red until Task 5.)

```bash
git add packages/transport-shared packages/server pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(comms): authoritative server — server-computed deltas

Wire protocol flips append/appendOk/appendConflict/putSnapshot to submit/committed;
the actor envelope is dropped (server derives the actor from the command). Table
wraps the engine Authority; createServer gains registry + genesisFor and runs the
engine to re-derive every delta. @wickedways/client is red until its transport flips.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: WebSocket client transport + client harness

Flip the client transport to `submit`/`committed`. **Restores full green** (`pnpm checks`).

**Files:**
- Modify: `packages/client/src/websocket-transport.ts`
- Modify: `packages/client/src/main.ts`
- Modify: `packages/client/src/websocket-transport.test.ts`, `convergence.test.ts`, `auth-convergence.test.ts`, `transport-contract.test.ts`

**Interfaces:**
- Consumes: the new `SyncTransport` (`submit`), `SubmitResult`, the new wire protocol (`submit`/`committed`), `Authority`/`createServer` with `registry`+`genesisFor`, `@wickedways/seed`.
- Produces: `WebSocketTransport implements SyncTransport` with `submit(command)`; no `append`/`putSnapshot`/`#actorFor`.

- [ ] **Step 1: Flip `websocket-transport.ts`**

Edit `packages/client/src/websocket-transport.ts`:

1. Imports (lines 1-6): drop `AppendResult`; import `SubmitResult` from `wickedways/lib/sync/transport`; drop `commandActorId`/`isJoinCommand` and the `Actor` type; keep `Command`, `LogEntry`, `WireLogEntry`, `ClientMsg`, `ServerMsg`, `CampaignSnapshot`, `parseServerMsg`. Resulting top:
   ```ts
   import type { SyncTransport, SubmitResult } from "wickedways/lib/sync/transport";
   import type { LogEntry, Command } from "wickedways/lib/sync/types";
   import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
   import { parseServerMsg, type ClientMsg, type WireLogEntry, type ServerMsg } from "@wickedways/transport-shared";
   ```
2. Replace the `#pendingAppend` field (line 58) with:
   ```ts
   #pendingSubmit: { resolve: (r: SubmitResult) => void; command: Command } | null = null;
   ```
3. `#reconnect` (lines 112-133): on a successful reconnect, a lost in-flight submit can no longer be retried by CAS — resolve it as a terminal rejection so the app can resubmit; the replica reconverges from the join backfill. Replace the pending-append handling at the end of `#reconnect`:
   - In the auth-error branch, change `p?.resolve({ ok: false, denied: true, reason: ... })` to use `#pendingSubmit` and `{ ok: false, denied: true, reason: reconnectAuthErrMsg }`.
   - In the success branch, replace the conflict resolution with:
     ```ts
     const pending = this.#pendingSubmit;
     this.#pendingSubmit = null;
     pending?.resolve({ ok: false, denied: true, reason: "connection lost; resubmit" });
     ```
4. `#onMessage` (lines 142-211): 
   - Replace the `case "appendOk"` block with:
     ```ts
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
     ```
   - Delete the entire `case "appendConflict"` block.
   - In the `case "denied"` block, change the in-flight branch from `#pendingAppend` to `#pendingSubmit` and resolve with `{ ok: false, denied: true, reason: msg.reason }`. The handshake-denial branch (sets `#authErrorMsg`, unblocks the snapshot/joined waiters) is unchanged.
5. Delete `putSnapshot` (lines 270-273) and `#actorFor` (lines 275-279).
6. Replace `append` (lines 281-291) with:
   ```ts
   submit(command: Command): Promise<SubmitResult> {
     return new Promise<SubmitResult>((resolve) => {
       this.#pendingSubmit = { resolve, command };
       this.#send({ t: "submit", campaignId: this.#opts.campaignId, command });
     });
   }
   ```
7. The `SyncTransport` interface no longer declares `putSnapshot`; ensure no `putSnapshot` remains. `loadSnapshot`, `entriesSince`, `subscribe`, `head`, `close` are unchanged.

- [ ] **Step 2: Simplify `client/main.ts`**

The client is always a replica now (the genesis lives on the server). Replace `packages/client/src/main.ts` lines 19-25 (the connect + coordinator construction) with:

```ts
async function main(): Promise<void> {
  const transport = await WebSocketTransport.connect({ url, campaignId, token: clientId });
  const coordinator = SyncCoordinator.join({ registry: buildSeedRegistry(), transport });
  coordinator.start();
```

Update the imports at the top of `main.ts`: drop `buildSeedCampaign` (no longer used) and keep `buildSeedRegistry` (imported from `./seed`, which re-exports `@wickedways/seed`). Remove the now-unused `serializeCampaign`-for-seeding only if it is no longer referenced (it is still used in `render`, so keep it). The rest of `main.ts` (render/run/button wiring) is unchanged.

- [ ] **Step 3: Update `websocket-transport.test.ts`**

Read `packages/client/src/websocket-transport.test.ts`. Replace `append` calls with `submit(command)`; replace `appendOk`/`appendConflict` server frames with `committed`/`denied`; drop `putSnapshot` and `actor` assertions. A representative happy-path test:

```ts
it("resolves submit when the server commits, applying the delta to the mirror", async () => {
  // ...connect with a fake server that replies committed{seq:1, delta}...
  const res = await transport.submit({ kind: "nextPlayer" });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.seq).toBe(1);
  expect(transport.head()).toBe(1);
});
```

For the fake server/socket used here, model `committed` (to the submitter) and `entry` (to others) per the new `Table.submit` contract. Run: `pnpm vitest run packages/client/src/websocket-transport.test.ts` → PASS.

- [ ] **Step 4: Update the integration suites (`convergence`, `auth-convergence`, `transport-contract`)**

These spin up a real `createServer` and real `WebSocketTransport`s. Apply throughout, using the **shared-genesis setup** from Task 4 Step 8 (`seedFixture()` — build the genesis once; character ids are random uuids, so `demoGenesis()` is unsafe for id-specific tests):

- Every `createServer(...)` gains `registry: buildSeedRegistry()` and `genesisFor: (id) => id === "demo" ? genesis : null` (the `genesis` from `seedFixture()`).
- Coordinators are built with `SyncCoordinator.join({ registry: buildSeedRegistry(), transport })` (no seeded campaign; the genesis is on the server).
- Commands submitted as a specific seat use `adaId`/`benId` from the same `seedFixture()` instance, matching how 3b's auth-convergence derived party ids.
- `coordinator.submit(command)` results are `{ ok, seq, delta }` or `{ rejected, reason }` — drop any `conflict` handling.
- Convergence assertions (byte-identical `serializeCampaign` across replicas after each command) are preserved.
- The anti-spoof test: a coordinator authenticated as Ben submitting a command with Ada's `actorId` resolves `{ rejected, reason: /not authorized/ }`, and the other replica is unchanged — now guaranteed by the server, with no client-side delta to forge.
- `transport-contract.test.ts`: replace the put-snapshot-then-advance choreography (3b) with the server-driven snapshot — late joiners get the server's authoritative snapshot on `getSnapshot`; assert a fresh `WebSocketTransport.connect` to an advanced session catches up to `head`.

Run: `pnpm vitest run packages/client` → PASS.

- [ ] **Step 5: Full checks + commit**

Run: `pnpm checks`
Expected: ALL green across every package — the red window is closed.

```bash
git add packages/client
git commit -m "$(cat <<'EOF'
feat(client): WebSocketTransport submits commands to the authoritative server

submit(command) replaces append(entry); committed{seq,delta} drives the mirror;
appendConflict/putSnapshot/#actorFor removed. The client is now a pure replica
(SyncCoordinator.join). Full workspace is green again.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Documentation

Update the README and the TSDoc that described the client-resolves / trusted-peers model.

**Files:**
- Modify: `README.md`
- Modify: TSDoc in `src/lib/sync/resolver.ts` (class doc), `src/lib/sync/coordinator.ts` (already rewritten in Task 3 — verify accuracy), `packages/server/src/server.ts` (the `createServer` doc comment, currently describing an engine-agnostic relay)

- [ ] **Step 1: Update the README multiplayer section**

Read the README's multiplayer / comms section (the 3a "Multiplayer client" block and the 3b "Authentication, seat ownership & presence" subsection). Replace the security-boundary prose: the boundary is no longer "authentication + envelope-ownership, not impersonation-proof." State the authoritative-server guarantee:

- The server runs the engine and re-derives every delta from the submitted command; clients submit commands only and apply authoritative deltas (wait-for-authority).
- Impersonation is structurally prevented: there is no client-supplied delta to forge, and seat ownership is checked against the actor read from the command.
- Genesis comes from the host's `genesisFor`, not from any client.
- Note what remains deferred to a later spec: client-side prediction + deterministic rng; durable membership/campaign persistence; per-identity seat caps / map pruning.

Keep the prose consistent with the spec's "Security outcome" and "Explicitly out of scope" sections.

- [ ] **Step 2: Update TSDoc**

- `src/lib/sync/resolver.ts` class doc (lines 15-22): it says "the same code is the future authoritative server's authority." Update to reflect that the `Authority` unit now hosts it on both the in-process transport and the room server (no longer "future").
- `packages/server/src/server.ts` `createServer` doc (lines 21-27): replace "The server never parses command/delta/snapshot semantics" with the authoritative description — the server runs the engine `Authority` to re-derive deltas; the only server-owned gate is seat ownership.
- Verify the `coordinator.ts` and `transport.ts` class docs (rewritten in Task 3) read accurately.

- [ ] **Step 3: Full checks + commit**

Run: `pnpm checks`
Expected: all green (docs/TSDoc only — no behavior change).

```bash
git add README.md src/lib/sync/resolver.ts packages/server/src/server.ts
git commit -m "$(cat <<'EOF'
docs(comms): document the authoritative server

README + TSDoc now describe server-computed deltas and the structural
impersonation guarantee, replacing the trusted-peers / envelope-ownership
boundary. Notes the deferred follow-ups (prediction + deterministic rng,
durable persistence).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Authority §2 → Task 1; coordinator/transport §3-4 → Task 3; wire protocol §5 → Task 4; server §6 (+ genesis §Decision 7, drop-envelope §Decision 5, remove-putSnapshot §Decision 6) → Task 4; client §7 → Task 5; error handling §8 + security outcome §9 → Tasks 3-5 (tests); testing §10 → distributed across each task's tests; docs → Task 6. The seed extraction (Task 2) is an enabling step the spec implies in §6 ("new workspace dependency").
- **Out of scope is honored:** no rng serialization, no prediction, no durable persistence in any task.
- **Type consistency:** `SubmitResult` (types.ts) is the single shape returned by `Authority.submit` (sync) and `SyncTransport.submit` (async-wrapped); `CommandResult` (no `conflict`) is the coordinator's surface; `Actor` stays in transport-shared for `Membership`; `actorOf` (server) mirrors the deleted client `#actorFor`.
- **Red window:** only Tasks 3 and 4 are scoped-red; Task 5 restores full `pnpm checks`. Each scoped-red task names its restorer and gives the exact scoped command.
