# Comms Sub-Spec 3a — Client Shell + Real-Time Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a pnpm-workspace monorepo with a self-hosted WebSocket "room" server and a browser dev harness that drive the real engine + Spec 2 `SyncCoordinator` over a concrete `WebSocketTransport`, so two browser tabs converge on identical game state over the wire.

**Architecture:** The engine stays a pure library at the repo root. Three new source-only workspace packages are added under `packages/`: `transport-shared` (engine-free wire types + validators), `server` (Node + `ws`: in-memory per-room CAS log, snapshot store, broadcast — depends only on `transport-shared`), and `client` (Vite + vanilla TS: a `WebSocketTransport` implementing Spec 2's `SyncTransport`, plus a minimal harness). The server is a dumb ordered-log relay; the client still resolves locally via `SyncCoordinator`. One small Spec-2 change makes the `append`/`submit` seam async so a real network CAS verdict can be awaited.

**Tech Stack:** TypeScript (strict, NodeNext), pnpm workspaces, Node 22, `ws`, Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-18-comms-client-backend-design.md`

## Global Constraints

- **pnpm workspaces monorepo.** Engine stays the root package `wickedways`; new packages live under `packages/*`. pnpm `9.15.6`, Node `22`.
- **TypeScript strictness unchanged:** `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, `moduleResolution: NodeNext`. Indexed access yields `T | undefined` — handle it; never cast to silence.
- **The server is engine-agnostic.** `packages/server` depends only on `@wickedways/transport-shared` and `ws`. It handles **opaque** `command`/`delta`/`snapshot` payloads keyed by `campaignId`. It MUST NOT import the engine; pnpm strictness enforces this (engine is not in the server's dependencies).
- **One engine change only:** `SyncTransport.append` → `Promise<AppendResult>` and `SyncCoordinator.submit` → `Promise<CommandResult>`. All other Spec-2 sync code is unchanged. The mirror-served sync reads (`head`, `entriesSince`, `loadSnapshot`, `subscribe`, `putSnapshot`) stay synchronous.
- **Trusted-peers (Spec 2 carry-over):** the network layer does NO seat validation in 3a. A client declares an opaque `clientId` on join; the server relays. Seat-ownership/auth is 3b.
- **All tests are Vitest, co-located `*.test.ts`.** The root `vitest run` globs `**/*.test.ts` (excluding `node_modules`), so package tests are discovered automatically.
- **Cross-package imports of our own code use package names**, never relative paths that climb out of a package: engine via `wickedways/lib/...`, wire types via `@wickedways/transport-shared`.
- **Injectable `WebSocket`:** `WebSocketTransport` takes a `WebSocket` constructor (default: global `WebSocket` for the browser; Node tests inject `ws`'s `WebSocket`). No direct `new WebSocket` against a global in shared code paths.
- **Living docs:** README gains a "Running the multiplayer client" section; new public surfaces get TSDoc; `CLAUDE.md` commands switch npm → pnpm.

---

## File Structure

**Created:**
- `pnpm-workspace.yaml` — workspace globs.
- `vitest.config.ts` — root Vitest config (so package tests resolve workspace packages; explicit `node` env).
- `packages/transport-shared/package.json`, `tsconfig.json`, `src/index.ts`, `src/index.test.ts` — wire message types (`WireLogEntry`, `ClientMsg`, `ServerMsg`) + runtime validators (`parseClientMsg`, `parseServerMsg`).
- `packages/server/package.json`, `tsconfig.json`, `src/table.ts`, `src/table.test.ts`, `src/server.ts`, `src/server.test.ts`, `src/main.ts` — `Table` (the server-side per-campaign coordinator: CAS log + snapshot + participants + broadcast; the server analog of the client's `SyncCoordinator`, named for the virtual tabletop and to avoid colliding with the engine's game-location `Room`), `createServer` (thin WS→`Table` adapter + table registry), `main` (dev entrypoint).
- `packages/client/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/websocket-transport.ts`, `src/websocket-transport.test.ts`, `src/seed.ts`, `src/seed.test.ts`, `src/transport-contract.test.ts`, `src/convergence.test.ts`, `src/main.ts` — the concrete transport, the seed campaign, the shared contract suite, the convergence/reconnect integration tests, and the harness page.

**Modified:**
- `package.json` (root) — add `packageManager`, `exports` map for the engine, pnpm scripts, dev deps shared by tests.
- `src/lib/sync/transport.ts` — `append` returns `Promise<AppendResult>`.
- `src/lib/sync/coordinator.ts` — `submit` returns `Promise<CommandResult>`; `await` the append.
- `src/lib/sync/coordinator.test.ts` (+ any other callers found by grep) — `await` submit/append.
- `.github/workflows/checks.yml`, `.github/workflows/docs.yml` — pnpm.
- `CLAUDE.md` — npm → pnpm command references.
- `README.md` — "Running the multiplayer client" + monorepo note.

---

## Task 1: pnpm migration + workspace skeleton

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root), `.github/workflows/checks.yml`, `.github/workflows/docs.yml`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a pnpm workspace whose root package `wickedways` still passes `pnpm checks`; the `packages/*` glob is registered (no packages exist yet). The engine `exports` map (`"./lib/*": "./src/lib/*.ts"`) so later packages can import `wickedways/lib/...`.

- [ ] **Step 1: Add the workspace + root Vitest config**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

Create `vitest.config.ts` (one root config discovers co-located tests across the engine and every package; `node` environment — the client harness DOM lives only in untested `main.ts`):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: Add packageManager + exports to root package.json**

In `package.json`, add the `packageManager` field and an `exports` map exposing engine source under `wickedways/lib/*`. Insert `"packageManager": "pnpm@9.15.6",` after the `"version"` line, and add this `exports` block after `"main"`:

```json
  "packageManager": "pnpm@9.15.6",
  "exports": {
    "./lib/*": "./src/lib/*.ts"
  },
```

(The `exports` map adds the `.ts` extension internally, so consumers import `wickedways/lib/sync/coordinator` with no extension. This serves source for the dev monorepo; a future published build would repoint `exports` at `dist/*.js`.)

- [ ] **Step 3: Convert scripts to pnpm**

Replace the `scripts` block in `package.json` so internal calls use `pnpm run`:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage --coverage.include='src/**'",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "checks": "pnpm run lint && pnpm -r run typecheck && pnpm run test",
    "build": "tsc -p tsconfig.build.json",
    "docs:api": "typedoc",
    "docs:dev": "pnpm run docs:api && vitepress dev docs-site",
    "docs:build": "pnpm run docs:api && vitepress build docs-site",
    "docs:preview": "vitepress preview docs-site"
  },
```

**Aggregate-checks design (referenced by later tasks):** `eslint .` from the root lints every package's `.ts` (flat config ignores only `dist/`, `coverage/`, `node_modules/`, `docs-site/`). The root `vitest run` globs `**/*.test.ts`, so it runs every package's tests in one pass — packages therefore do **not** define their own `test` script. Typecheck is per-tsconfig, so each package added later defines its own `"typecheck": "tsc --noEmit"` script, and `pnpm -r run typecheck` runs the root engine typecheck plus each package's.

- [ ] **Step 4: Generate the pnpm lockfile from the existing npm lockfile**

Run: `pnpm import`
Expected: writes `pnpm-lock.yaml` from `package-lock.json`.

Then remove the npm lockfile and install:

Run: `rm package-lock.json && pnpm install`
Expected: `pnpm install` completes; `node_modules/` is pnpm-managed.

- [ ] **Step 5: Update CI workflows to pnpm**

Replace `.github/workflows/checks.yml` with:

```yaml
name: Checks

# Run lint, typecheck, and tests on every pull request (opened, reopened, and
# on each new push to the PR branch).
on:
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.6
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run checks
```

In `.github/workflows/docs.yml`, apply the same pattern: add the `pnpm/action-setup@v4` step (version `9.15.6`) **before** `actions/setup-node@v4`, change `cache: npm` → `cache: pnpm`, replace `npm ci` → `pnpm install --frozen-lockfile`, and replace any `npm run <x>` → `pnpm run <x>`.

- [ ] **Step 6: Update CLAUDE.md command references**

In `CLAUDE.md`, change the `## Commands` block and the single-test examples from `npm run …`/`npx vitest` to `pnpm …`: `npm run checks` → `pnpm checks`, `npm test` → `pnpm test`, `npm run typecheck` → `pnpm typecheck`, `npm run lint:fix` → `pnpm lint:fix`, `npm run build` → `pnpm build`, `npm run docs:dev` → `pnpm docs:dev`, `npm run docs:build` → `pnpm docs:build`, and `npx vitest run …` → `pnpm vitest run …`.

- [ ] **Step 7: Verify the engine still passes under pnpm**

Run: `pnpm checks`
Expected: lint, typecheck, and the full existing engine test suite all pass (same green suite as before the migration), now via pnpm.

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml vitest.config.ts package.json pnpm-lock.yaml .github/workflows/checks.yml .github/workflows/docs.yml CLAUDE.md
git rm package-lock.json
git commit -m "build: migrate to pnpm workspaces; expose engine src via exports"
```

---

## Task 2: Async `append`/`submit` seam (the one engine change)

**Files:**
- Modify: `src/lib/sync/transport.ts`, `src/lib/sync/coordinator.ts`
- Test: `src/lib/sync/coordinator.test.ts` (+ any other `submit(`/`append(` callers found by grep)

**Interfaces:**
- Consumes: Spec 2's `SyncTransport`, `AppendResult`, `SyncCoordinator`, `LogEntry`, `Command`, `CommandResult`.
- Produces: `SyncTransport.append(entry: LogEntry): Promise<AppendResult>` and `SyncCoordinator.submit(command: Command): Promise<CommandResult>`. The `#lastApplied = seq` assignment stays **before** the append call (preserving the own-entry-skip ordering). `head`, `entriesSince`, `subscribe`, `loadSnapshot`, `putSnapshot`, and `SyncCoordinator.join` remain synchronous.

- [ ] **Step 1: Make the interface + in-process append async**

In `src/lib/sync/transport.ts`, change the interface method signature:

```ts
  /** Compare-and-swap append: succeeds iff `entry.baseSeq === head()`. */
  append(entry: LogEntry): Promise<AppendResult>;
```

And make `InProcessTransport.append` async (body unchanged — the synchronous subscriber notification still runs inline before the returned promise resolves):

```ts
  async append(entry: LogEntry): Promise<AppendResult> {
    const head = this.head();
    if (entry.baseSeq !== head) {
      return { ok: false, conflict: true, head };
    }
    this.log.push(entry);
    for (const handler of this.subscribers) handler(entry);
    return { ok: true };
  }
```

- [ ] **Step 2: Make `submit` async and await the append**

In `src/lib/sync/coordinator.ts`, change the `submit` signature to `async … : Promise<CommandResult>` and `await` the append. The body is otherwise unchanged — critically, `this.#lastApplied = seq;` stays **before** the append:

```ts
  async submit(command: Command): Promise<CommandResult> {
    const auth = this.#resolver.authorize(this.#local, command);
    if (!auth.ok) return { ok: false, rejected: true, reason: auth.reason };

    const { snapshot: before, index: rawIndex } = serializeCampaignWithIndex(this.#local);
    try {
      this.#resolver.apply(this.#local, command, new EntityIndex(rawIndex));
    } catch (e) {
      if (e instanceof ProceduralViolation) {
        this.#restore(before);
        return { ok: false, rejected: true, reason: e.message };
      }
      throw e;
    }

    const after = serializeCampaign(this.#local);
    const delta = this.#deltaComputer.diff(before, after);
    const baseSeq = this.#transport.head();
    const seq = baseSeq + 1;
    // Advance #lastApplied BEFORE append so a synchronous self-notification sees
    // `entry.seq <= #lastApplied` and skips our own entry. resolver.apply already
    // advanced #local.
    this.#lastApplied = seq;
    const res = await this.#transport.append({ seq, baseSeq, command, delta });
    if (!res.ok) {
      this.#lastApplied = baseSeq;
      this.#restore(before);
      this.#syncTo(res.head);
      return { ok: false, conflict: true, reason: `Stale base ${baseSeq}; head is ${res.head}. Retry.` };
    }
    if (seq % this.#snapshotEvery === 0) {
      this.#transport.putSnapshot(seq, after);
    }
    return { ok: true, seq, delta };
  }
```

- [ ] **Step 3: Find and update all callers**

Run: `grep -rn "\.submit(" src/lib` and `grep -rn "\.append(" src/lib`
Update every call site to `await` the now-async method (the enclosing test/function becomes `async`). The known site is `src/lib/sync/coordinator.test.ts`; update any others the grep surfaces (e.g. an integration test). In tests, change `const res = coord.submit(cmd)` → `const res = await coord.submit(cmd)`, and ensure the `it(...)` callback is `async`.

- [ ] **Step 4: Run the sync suite to verify it stays green**

Run: `pnpm vitest run src/lib/sync`
Expected: PASS — all Spec-2 sync tests pass with the awaited async seam, including the own-entry-skip and CAS-conflict tests.

- [ ] **Step 5: Run the full engine suite**

Run: `pnpm checks`
Expected: lint, typecheck, full suite all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/transport.ts src/lib/sync/coordinator.ts src/lib/sync/coordinator.test.ts
git commit -m "refactor(sync): make append/submit async for real-network CAS verdicts"
```

---

## Task 3: `transport-shared` — wire types + validators

**Files:**
- Create: `packages/transport-shared/package.json`, `packages/transport-shared/tsconfig.json`, `packages/transport-shared/src/index.ts`
- Test: `packages/transport-shared/src/index.test.ts`

**Interfaces:**
- Consumes: nothing (engine-free; pure types + JS validators).
- Produces: `WireLogEntry { seq: number; baseSeq: number; command: unknown; delta: unknown }`; `ClientMsg`/`ServerMsg` discriminated unions (below); `parseClientMsg(raw: unknown): ClientMsg | null` and `parseServerMsg(raw: unknown): ServerMsg | null`. `command`/`delta`/`snapshot` are **opaque** (`unknown`) so the server never depends on the engine.

- [ ] **Step 1: Create the package manifest**

`packages/transport-shared/package.json`:

```json
{
  "name": "@wickedways/transport-shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

`packages/transport-shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Write the failing validator test**

`packages/transport-shared/src/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseClientMsg, parseServerMsg } from "./index.js";

describe("parseClientMsg", () => {
  it("accepts a well-formed join", () => {
    expect(parseClientMsg({ t: "join", campaignId: "c1", clientId: "a", fromSeq: 0 })).toEqual({
      t: "join", campaignId: "c1", clientId: "a", fromSeq: 0,
    });
  });

  it("accepts an append with an opaque entry", () => {
    const entry = { seq: 1, baseSeq: 0, command: { kind: "x" }, delta: { changed: [] } };
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry })).toEqual({
      t: "append", campaignId: "c1", entry,
    });
  });

  it("rejects unknown discriminants and malformed shapes", () => {
    expect(parseClientMsg({ t: "nope" })).toBeNull();
    expect(parseClientMsg({ t: "join", campaignId: "c1" })).toBeNull(); // missing fields
    expect(parseClientMsg(null)).toBeNull();
    expect(parseClientMsg("join")).toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry: { seq: 1 } })).toBeNull(); // bad entry
  });
});

describe("parseServerMsg", () => {
  it("accepts joined / appendOk / appendConflict / snapshot(null) / error", () => {
    expect(parseServerMsg({ t: "joined", head: 3 })).toEqual({ t: "joined", head: 3 });
    expect(parseServerMsg({ t: "appendOk", seq: 4 })).toEqual({ t: "appendOk", seq: 4 });
    expect(parseServerMsg({ t: "appendConflict", head: 7 })).toEqual({ t: "appendConflict", head: 7 });
    expect(parseServerMsg({ t: "snapshot", seq: 0, snapshot: null })).toEqual({ t: "snapshot", seq: 0, snapshot: null });
    expect(parseServerMsg({ t: "error", message: "bad" })).toEqual({ t: "error", message: "bad" });
  });

  it("rejects malformed server messages", () => {
    expect(parseServerMsg({ t: "joined" })).toBeNull();
    expect(parseServerMsg({ t: "snapshot", seq: 1 })).toBeNull(); // missing snapshot key
    expect(parseServerMsg(42)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/transport-shared`
Expected: FAIL — `./index.js` has no exports yet.

- [ ] **Step 4: Implement the wire types + validators**

`packages/transport-shared/src/index.ts`:

```ts
/**
 * The wire protocol shared by the comms client and room server. `command`,
 * `delta`, and `snapshot` are **opaque** (`unknown`) here: the server relays and
 * orders them without understanding the engine, so this package has no engine
 * dependency.
 */

/** A log entry as carried on the wire (Spec 2's `LogEntry` with opaque payloads). */
export interface WireLogEntry {
  seq: number;
  baseSeq: number;
  command: unknown;
  delta: unknown;
}

/** Messages a client sends to the room server. */
export type ClientMsg =
  | { t: "join"; campaignId: string; clientId: string; fromSeq: number }
  | { t: "append"; campaignId: string; entry: WireLogEntry }
  | { t: "getSnapshot"; campaignId: string }
  | { t: "putSnapshot"; campaignId: string; seq: number; snapshot: unknown };

/** Messages the room server sends to a client. */
export type ServerMsg =
  | { t: "joined"; head: number }
  | { t: "entry"; entry: WireLogEntry }
  | { t: "appendOk"; seq: number }
  | { t: "appendConflict"; head: number }
  | { t: "snapshot"; seq: number; snapshot: unknown }
  | { t: "error"; message: string };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isWireLogEntry(x: unknown): x is WireLogEntry {
  return isObj(x) && typeof x.seq === "number" && typeof x.baseSeq === "number" && "command" in x && "delta" in x;
}

/** Validates an inbound client message; returns it narrowed, or `null` if malformed. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "join":
      return typeof raw.campaignId === "string" && typeof raw.clientId === "string" && typeof raw.fromSeq === "number"
        ? { t: "join", campaignId: raw.campaignId, clientId: raw.clientId, fromSeq: raw.fromSeq }
        : null;
    case "append":
      return typeof raw.campaignId === "string" && isWireLogEntry(raw.entry)
        ? { t: "append", campaignId: raw.campaignId, entry: raw.entry }
        : null;
    case "getSnapshot":
      return typeof raw.campaignId === "string" ? { t: "getSnapshot", campaignId: raw.campaignId } : null;
    case "putSnapshot":
      return typeof raw.campaignId === "string" && typeof raw.seq === "number" && "snapshot" in raw
        ? { t: "putSnapshot", campaignId: raw.campaignId, seq: raw.seq, snapshot: raw.snapshot }
        : null;
    default:
      return null;
  }
}

/** Validates an inbound server message; returns it narrowed, or `null` if malformed. */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "joined":
      return typeof raw.head === "number" ? { t: "joined", head: raw.head } : null;
    case "entry":
      return isWireLogEntry(raw.entry) ? { t: "entry", entry: raw.entry } : null;
    case "appendOk":
      return typeof raw.seq === "number" ? { t: "appendOk", seq: raw.seq } : null;
    case "appendConflict":
      return typeof raw.head === "number" ? { t: "appendConflict", head: raw.head } : null;
    case "snapshot":
      return typeof raw.seq === "number" && "snapshot" in raw
        ? { t: "snapshot", seq: raw.seq, snapshot: raw.snapshot }
        : null;
    case "error":
      return typeof raw.message === "string" ? { t: "error", message: raw.message } : null;
    default:
      return null;
  }
}
```

- [ ] **Step 5: Install the workspace and run the test**

Run: `pnpm install` (links the new workspace package), then `pnpm vitest run packages/transport-shared`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r run typecheck`
Expected: PASS for root + `@wickedways/transport-shared`.

> **Known-risk note for the implementer (applies to Tasks 5–9 too):** consuming a workspace package whose `exports`/`main` points at `.ts` source is the intended source-only-monorepo setup. If `tsc` reports "can only end in '.ts'" when a *consumer* imports this package, add `"allowImportingTsExtensions": true` to the **consumer's** tsconfig `compilerOptions` (valid because all packages are `noEmit`). This package itself never imports a `.ts` by extension, so it does not need the flag.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-shared pnpm-lock.yaml
git commit -m "feat(transport-shared): engine-free wire types + message validators"
```

---

## Task 4: `server` — the `Table` (server-side per-campaign coordinator)

> **Naming:** this class is named `Table` (the virtual tabletop for one campaign's session), **not** `Room`, to avoid colliding with the engine's game-location `Room` (`src/lib/room.ts`). They are unrelated; the server never imports the engine. `Table` is the server analog of the client's `SyncCoordinator`.

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/table.ts`
- Test: `packages/server/src/table.test.ts`

**Interfaces:**
- Consumes: `WireLogEntry`, `ServerMsg` from `@wickedways/transport-shared`.
- Produces: `type Subscriber = (msg: ServerMsg) => void` and `class Table` with `head(): number`, `join(sub: Subscriber, fromSeq: number): void`, `leave(sub: Subscriber): void`, `append(entry: WireLogEntry, sender: Subscriber): void`, `sendSnapshot(requester: Subscriber): void`, `putSnapshot(seq: number, snapshot: unknown): void`. `Table` owns the ordered log, the latest snapshot, and the participant set; it emits ordered `ServerMsg`s through `Subscriber` callbacks (never raw sockets), so it is fully unit-testable without `ws`. The server is the ordering authority: `append` commits iff `entry.baseSeq === head()`, stamps `seq = head + 1`, acks the sender (`appendOk`/`appendConflict`), and on success broadcasts the committed `entry` to **all** participants (including the sender). Pure logic — no `ws`, no engine.

- [ ] **Step 1: Create the package manifest**

`packages/server/package.json`:

```json
{
  "name": "@wickedways/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@wickedways/transport-shared": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.2"
  }
}
```

`packages/server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Write the failing `Table` test**

`packages/server/src/table.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";
import { Table, type Subscriber } from "./table.js";

const entry = (seq: number, baseSeq: number): WireLogEntry => ({
  seq, baseSeq, command: { kind: "noop" }, delta: { changed: [], created: [], removed: [] },
});

/** A fake participant that records the messages it receives. */
function recorder(): { sub: Subscriber; msgs: ServerMsg[] } {
  const msgs: ServerMsg[] = [];
  return { sub: (m) => msgs.push(m), msgs };
}

describe("Table", () => {
  it("acks a join with the current head", () => {
    const t = new Table();
    const a = recorder();
    t.join(a.sub, 0);
    expect(a.msgs).toEqual([{ t: "joined", head: 0 }]);
  });

  it("commits an append, acks the sender, and broadcasts the entry to all participants", () => {
    const t = new Table();
    const a = recorder();
    const b = recorder();
    t.join(a.sub, 0);
    t.join(b.sub, 0);
    a.msgs.length = 0;
    b.msgs.length = 0;

    t.append(entry(1, 0), a.sub);

    expect(a.msgs).toEqual([{ t: "appendOk", seq: 1 }, { t: "entry", entry: entry(1, 0) }]);
    expect(b.msgs).toEqual([{ t: "entry", entry: entry(1, 0) }]);
    expect(t.head()).toBe(1);
  });

  it("rejects a stale-base append as a conflict to the sender only", () => {
    const t = new Table();
    const a = recorder();
    const b = recorder();
    t.join(a.sub, 0);
    t.join(b.sub, 0);
    t.append(entry(1, 0), a.sub);
    a.msgs.length = 0;
    b.msgs.length = 0;

    t.append(entry(2, 0), a.sub); // stale base

    expect(a.msgs).toEqual([{ t: "appendConflict", head: 1 }]);
    expect(b.msgs).toEqual([]); // no broadcast
    expect(t.head()).toBe(1); // unchanged
  });

  it("backfills entries strictly after fromSeq on join", () => {
    const t = new Table();
    const a = recorder();
    t.join(a.sub, 0);
    t.append(entry(1, 0), a.sub);
    t.append(entry(2, 1), a.sub);

    const b = recorder();
    t.join(b.sub, 0);
    expect(b.msgs).toEqual([
      { t: "joined", head: 2 },
      { t: "entry", entry: entry(1, 0) },
      { t: "entry", entry: entry(2, 1) },
    ]);
  });

  it("does not broadcast to a participant that has left", () => {
    const t = new Table();
    const a = recorder();
    const b = recorder();
    t.join(a.sub, 0);
    t.join(b.sub, 0);
    t.leave(b.sub);
    b.msgs.length = 0;

    t.append(entry(1, 0), a.sub);
    expect(b.msgs).toEqual([]);
  });

  it("sends the latest snapshot, or seq 0 / null when absent; lower-seq puts do not overwrite", () => {
    const t = new Table();
    const a = recorder();
    t.sendSnapshot(a.sub);
    expect(a.msgs).toEqual([{ t: "snapshot", seq: 0, snapshot: null }]);

    t.putSnapshot(5, { tag: "five" });
    t.putSnapshot(3, { tag: "three" }); // ignored (lower seq)
    a.msgs.length = 0;
    t.sendSnapshot(a.sub);
    expect(a.msgs).toEqual([{ t: "snapshot", seq: 5, snapshot: { tag: "five" } }]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/server`
Expected: FAIL — `./table.js` does not exist.

- [ ] **Step 4: Implement `Table`**

`packages/server/src/table.ts`:

```ts
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";

/** A connected participant: receives ordered server messages for one {@link Table}. */
export type Subscriber = (msg: ServerMsg) => void;

/**
 * The server-side coordinator for one campaign's session — the virtual tabletop.
 * Owns the ordered CAS log, the latest snapshot, and the participant set, and
 * emits ordered messages through {@link Subscriber} callbacks (never raw sockets),
 * so it is fully unit-testable without `ws`. The server is the ordering authority:
 * an append commits iff its `baseSeq` equals the current head, the committed `seq`
 * is stamped as `head + 1`, and the entry is broadcast to every participant.
 * Entirely engine-agnostic — entries and snapshots are opaque. Named `Table`
 * (not `Room`) to avoid colliding with the engine's game-location `Room`.
 */
export class Table {
  #log: WireLogEntry[] = [];
  #snapshot: { seq: number; snapshot: unknown } | null = null;
  #participants = new Set<Subscriber>();

  /** Highest committed seq (0 when empty). */
  head(): number {
    const last = this.#log[this.#log.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  /** Registers a participant, acks with the current head, then backfills entries after `fromSeq`. */
  join(sub: Subscriber, fromSeq: number): void {
    this.#participants.add(sub);
    sub({ t: "joined", head: this.head() });
    for (const e of this.#log) if (e.seq >= fromSeq + 1) sub({ t: "entry", entry: e });
  }

  /** Removes a participant (e.g. on disconnect). */
  leave(sub: Subscriber): void {
    this.#participants.delete(sub);
  }

  /**
   * Compare-and-swap append from `sender`. On success: acks `sender` with
   * `appendOk{seq}` and broadcasts the committed `entry` to all participants
   * (including `sender`). On a stale base: replies `appendConflict{head}` to
   * `sender` only, changing nothing.
   */
  append(entry: WireLogEntry, sender: Subscriber): void {
    const head = this.head();
    if (entry.baseSeq !== head) {
      sender({ t: "appendConflict", head });
      return;
    }
    const seq = head + 1;
    const committed: WireLogEntry = { ...entry, seq };
    this.#log.push(committed);
    sender({ t: "appendOk", seq });
    for (const p of this.#participants) p({ t: "entry", entry: committed });
  }

  /** Sends the latest checkpoint to `requester` (seq 0 / null when absent). */
  sendSnapshot(requester: Subscriber): void {
    const snap = this.#snapshot;
    requester(
      snap === null
        ? { t: "snapshot", seq: 0, snapshot: null }
        : { t: "snapshot", seq: snap.seq, snapshot: snap.snapshot },
    );
  }

  /** Stores a checkpoint at `seq` (last-writer-wins for `seq >=` the stored one). */
  putSnapshot(seq: number, snapshot: unknown): void {
    if (this.#snapshot === null || seq >= this.#snapshot.seq) {
      this.#snapshot = { seq, snapshot };
    }
  }
}
```

- [ ] **Step 5: Install + run the test**

Run: `pnpm install`, then `pnpm vitest run packages/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): Table — per-campaign coordinator (CAS log, snapshot, broadcast)"
```

---

## Task 5: `server` — WebSocket adapter (`createServer`) + `Table` registry

**Files:**
- Create: `packages/server/src/server.ts`, `packages/server/src/main.ts`
- Test: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `Table`, `Subscriber` (Task 4); `parseClientMsg`, `ServerMsg` from `@wickedways/transport-shared`.
- Produces: `createServer(opts?: { port?: number }): Promise<ServerHandle>` where `ServerHandle = { port: number; close(): Promise<void> }`. A **thin adapter**: each connection becomes a `Subscriber` that JSON-serializes to its socket; the server keeps a `Map<campaignId, Table>` (created on first reference), validates each inbound frame with `parseClientMsg` (malformed → `error`, never crashes), and routes `join`/`append`/`getSnapshot`/`putSnapshot` to the campaign's `Table`. All ordering, acking, and broadcast live in `Table`. On socket close, the connection's `Subscriber` is removed from every table it joined. `main.ts` is a dev entrypoint (not tested).

- [ ] **Step 1: Write the failing server integration test**

`packages/server/src/server.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { parseServerMsg, type ServerMsg, type WireLogEntry } from "@wickedways/transport-shared";
import { createServer, type ServerHandle } from "./server.js";

let handle: ServerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

/** Opens a ws client to the running server and resolves once it is open. */
function open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(e));
  });
}

/** Collects the next `n` parsed server messages from a socket. */
function collect(ws: WebSocket, n: number): Promise<ServerMsg[]> {
  return new Promise((resolve) => {
    const out: ServerMsg[] = [];
    const onMsg = (ev: { data: unknown }) => {
      const msg = parseServerMsg(JSON.parse(String(ev.data)));
      if (msg) out.push(msg);
      if (out.length >= n) {
        ws.removeEventListener("message", onMsg as never);
        resolve(out);
      }
    };
    ws.addEventListener("message", onMsg as never);
  });
}

const entry = (seq: number, baseSeq: number): WireLogEntry => ({
  seq, baseSeq, command: { kind: "noop" }, delta: { changed: [] },
});

describe("createServer", () => {
  it("acks a join with the current head", async () => {
    handle = await createServer({ port: 0 });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", clientId: "a", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "joined", head: 0 }]);
    a.close();
  });

  it("commits an append, acks the sender, and broadcasts the entry to all subscribers", async () => {
    handle = await createServer({ port: 0 });
    const a = await open(handle.port);
    const b = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", clientId: "a", fromSeq: 0 }));
    b.send(JSON.stringify({ t: "join", campaignId: "c1", clientId: "b", fromSeq: 0 }));
    await collect(a, 1); // joined
    await collect(b, 1); // joined

    const bEntry = collect(b, 1);
    const aReplies = collect(a, 2); // appendOk + own-entry broadcast
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0) }));

    expect(await bEntry).toEqual([{ t: "entry", entry: { ...entry(1, 0) } }]);
    const replies = await aReplies;
    expect(replies).toContainEqual({ t: "appendOk", seq: 1 });
    expect(replies).toContainEqual({ t: "entry", entry: { ...entry(1, 0) } });
    a.close();
    b.close();
  });

  it("rejects a stale-base append as a conflict reporting head", async () => {
    handle = await createServer({ port: 0 });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", clientId: "a", fromSeq: 0 }));
    await collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0) }));
    await collect(a, 2); // appendOk + entry
    const conflict = collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 0) })); // stale base
    expect(await conflict).toEqual([{ t: "appendConflict", head: 1 }]);
    a.close();
  });

  it("backfills entries since fromSeq on join", async () => {
    handle = await createServer({ port: 0 });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", clientId: "a", fromSeq: 0 }));
    await collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0) }));
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1) }));
    await collect(a, 4); // 2x (appendOk + entry)

    const b = await open(handle.port);
    const bMsgs = collect(b, 3); // joined + 2 backfilled entries
    b.send(JSON.stringify({ t: "join", campaignId: "c1", clientId: "b", fromSeq: 0 }));
    const msgs = await bMsgs;
    expect(msgs[0]).toEqual({ t: "joined", head: 2 });
    expect(msgs.slice(1)).toEqual([
      { t: "entry", entry: { ...entry(1, 0) } },
      { t: "entry", entry: { ...entry(2, 1) } },
    ]);
    a.close();
    b.close();
  });

  it("round-trips a snapshot and replies null when absent", async () => {
    handle = await createServer({ port: 0 });
    const a = await open(handle.port);
    const none = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "c1" }));
    expect(await none).toEqual([{ t: "snapshot", seq: 0, snapshot: null }]);

    a.send(JSON.stringify({ t: "putSnapshot", campaignId: "c1", seq: 2, snapshot: { tag: "two" } }));
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "c1" }));
    expect(await got).toEqual([{ t: "snapshot", seq: 2, snapshot: { tag: "two" } }]);
    a.close();
  });

  it("replies error on malformed input without crashing the room", async () => {
    handle = await createServer({ port: 0 });
    const a = await open(handle.port);
    const err = collect(a, 1);
    a.send("not json");
    expect(await err).toEqual([{ t: "error", message: "Invalid JSON" }]);
    a.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/server/src/server.test.ts`
Expected: FAIL — `./server.js` has no `createServer`.

- [ ] **Step 3: Implement `createServer`**

`packages/server/src/server.ts`:

```ts
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg } from "@wickedways/transport-shared";
import { Table, type Subscriber } from "./table.js";

/** A running room server. */
export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Starts a WebSocket server: a thin adapter over a `Map<campaignId, Table>`. Each
 * connection becomes a {@link Subscriber} that JSON-serializes messages to its
 * socket; all ordering, acking, and broadcast live in {@link Table}. The server
 * never inspects `command`/`delta`/`snapshot` payloads.
 */
export function createServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const tables = new Map<string, Table>();
  const tableFor = (id: string): Table => {
    let t = tables.get(id);
    if (t === undefined) { t = new Table(); tables.set(id, t); }
    return t;
  };

  const wss = new WebSocketServer({ port: opts.port ?? 0 });

  wss.on("connection", (ws: WebSocket) => {
    const send: Subscriber = (msg: ServerMsg) => ws.send(JSON.stringify(msg));
    const joined = new Set<string>();

    ws.on("message", (data: { toString(): string }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send({ t: "error", message: "Invalid JSON" });
        return;
      }
      const msg = parseClientMsg(raw);
      if (msg === null) {
        send({ t: "error", message: "Malformed message" });
        return;
      }

      switch (msg.t) {
        case "join":
          tableFor(msg.campaignId).join(send, msg.fromSeq);
          joined.add(msg.campaignId);
          break;
        case "append":
          tableFor(msg.campaignId).append(msg.entry, send);
          break;
        case "getSnapshot":
          tableFor(msg.campaignId).sendSnapshot(send);
          break;
        case "putSnapshot":
          tableFor(msg.campaignId).putSnapshot(msg.seq, msg.snapshot);
          break;
      }
    });

    ws.on("close", () => {
      for (const id of joined) tables.get(id)?.leave(send);
    });
  });

  return new Promise((resolve) => {
    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 0);
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            for (const client of wss.clients) client.terminate();
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
```

- [ ] **Step 4: Write the dev entrypoint**

`packages/server/src/main.ts`:

```ts
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
void createServer({ port }).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}`);
});
```

- [ ] **Step 5: Run the server test suite**

Run: `pnpm vitest run packages/server`
Expected: PASS — `Table` unit tests and the integration tests (join ack, append+broadcast, conflict, backfill, snapshot, malformed-error) all pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): WebSocket adapter over Table registry, dev entrypoint"
```

---

## Task 6: `client` — `WebSocketTransport` (warm mirror + async append)

**Files:**
- Create: `packages/client/package.json`, `packages/client/tsconfig.json`, `packages/client/src/websocket-transport.ts`
- Test: `packages/client/src/websocket-transport.test.ts`

**Interfaces:**
- Consumes: Spec 2 `SyncTransport`, `AppendResult` (`wickedways/lib/sync/transport`), `LogEntry` (`wickedways/lib/sync/types`), `CampaignSnapshot` (`wickedways/lib/serialization/types`); `parseServerMsg`, `ClientMsg`, `WireLogEntry` (`@wickedways/transport-shared`); the `@wickedways/server` `createServer` (test only).
- Produces: `class WebSocketTransport implements SyncTransport` with a static `connect(opts: { url: string; campaignId: string; clientId: string; factory?: WebSocketFactory }): Promise<WebSocketTransport>` and a `close(): void`. `type WebSocketFactory = (url: string) => WebSocketLike` (default: browser global `WebSocket`; Node tests inject `ws`). Keeps a **warm local mirror** (`#log`/`#head`/`#snapshot`) fed by the server subscription so all synchronous `SyncTransport` reads are served locally; only `append` awaits the server's CAS verdict. On `appendConflict{head}` it **waits until the mirror has caught up to `head`** before resolving, so the coordinator's `#syncTo` sees the foreign entries. On socket drop it reconnects, re-joins from `#head` (backfill heals the gap), and resolves any in-flight append as a conflict so the coordinator retries.

- [ ] **Step 1: Create the package manifest**

`packages/client/package.json`:

```json
{
  "name": "@wickedways/client",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "wickedways": "workspace:*",
    "@wickedways/transport-shared": "workspace:*"
  },
  "devDependencies": {
    "@wickedways/server": "workspace:*",
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.12",
    "ws": "^8.18.0",
    "vite": "^6.0.0"
  }
}
```

`packages/client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Write the failing transport test**

`packages/client/src/websocket-transport.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type ServerHandle } from "@wickedways/server";
import type { LogEntry } from "wickedways/lib/sync/types";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";

const nodeFactory: WebSocketFactory = (url) => new WebSocket(url) as never;

let handle: ServerHandle | null = null;
const transports: WebSocketTransport[] = [];
afterEach(async () => {
  for (const t of transports) t.close();
  transports.length = 0;
  await handle?.close();
  handle = null;
});

async function connect(campaignId: string, clientId: string): Promise<WebSocketTransport> {
  const t = await WebSocketTransport.connect({
    url: `ws://127.0.0.1:${handle!.port}`,
    campaignId,
    clientId,
    factory: nodeFactory,
  });
  transports.push(t);
  return t;
}

const entry = (seq: number, baseSeq: number): LogEntry =>
  ({ seq, baseSeq, command: { kind: "nextPlayer" }, delta: { changed: [], created: [], removed: [] } }) as unknown as LogEntry;

describe("WebSocketTransport", () => {
  it("connects warm at head 0 with no snapshot", async () => {
    handle = await createServer({ port: 0 });
    const a = await connect("c1", "a");
    expect(a.head()).toBe(0);
    expect(a.loadSnapshot()).toBeNull();
  });

  it("appends under CAS and reflects the committed entry in its own mirror", async () => {
    handle = await createServer({ port: 0 });
    const a = await connect("c1", "a");
    const res = await a.append(entry(1, 0));
    expect(res).toEqual({ ok: true });
    expect(a.head()).toBe(1);
    expect(a.entriesSince(1).map((e) => e.seq)).toEqual([1]);
  });

  it("delivers a peer's committed entry to a subscriber", async () => {
    handle = await createServer({ port: 0 });
    const a = await connect("c1", "a");
    const b = await connect("c1", "b");
    const seen: number[] = [];
    b.subscribe(b.head() + 1, (e) => seen.push(e.seq));
    await a.append(entry(1, 0));
    await vi_tick();
    expect(seen).toEqual([1]);
    expect(b.head()).toBe(1);
  });

  it("reports a CAS conflict and brings the mirror up to head before resolving", async () => {
    handle = await createServer({ port: 0 });
    const a = await connect("c1", "a");
    const b = await connect("c1", "b");
    await a.append(entry(1, 0)); // commits seq 1; b receives it via broadcast
    await vi_tick();
    // b still thinks base 0 is current and submits against it -> conflict
    const res = await b.append(entry(1, 0));
    expect(res).toEqual({ ok: false, conflict: true, head: 1 });
    expect(b.entriesSince(1).map((e) => e.seq)).toEqual([1]); // foreign entry present
  });

  it("late-joins from a stored snapshot and backfills entries since", async () => {
    handle = await createServer({ port: 0 });
    const a = await connect("c1", "a");
    a.putSnapshot(0, { schemaVersion: 1, tag: "seed" } as never);
    await a.append(entry(1, 0));
    await a.append(entry(2, 1));
    await vi_tick();

    const b = await connect("c1", "b");
    expect(b.loadSnapshot()).toEqual({ seq: 0, snapshot: { schemaVersion: 1, tag: "seed" } });
    expect(b.head()).toBe(2);
    expect(b.entriesSince(1).map((e) => e.seq)).toEqual([1, 2]);
  });
});

/** Flush microtasks + a macrotask so broadcast messages are delivered. */
function vi_tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm install`, then `pnpm vitest run packages/client/src/websocket-transport.test.ts`
Expected: FAIL — `./websocket-transport.js` has no exports.

- [ ] **Step 4: Implement `WebSocketTransport`**

`packages/client/src/websocket-transport.ts`:

```ts
import type { SyncTransport, AppendResult } from "wickedways/lib/sync/transport";
import type { LogEntry } from "wickedways/lib/sync/types";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { parseServerMsg, type ClientMsg, type WireLogEntry } from "@wickedways/transport-shared";

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

const browserFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

interface ConnectOpts {
  url: string;
  campaignId: string;
  clientId: string;
  factory?: WebSocketFactory;
}

/**
 * A concrete {@link SyncTransport} over a WebSocket room server. Keeps a warm
 * local mirror (log + head + snapshot) fed by the server subscription so every
 * synchronous read is served locally; only {@link WebSocketTransport.append}
 * awaits the server's compare-and-swap verdict. Construct via
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

  #pendingAppend: { resolve: (r: AppendResult) => void; entry: LogEntry } | null = null;
  #snapshotWaiter: ((m: { seq: number; snapshot: unknown }) => void) | null = null;
  #joinedWaiter: ((m: { head: number }) => void) | null = null;
  #openWaiter: (() => void) | null = null;

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
    await this.#awaitHead(joined.head);
  }

  async #reconnect(): Promise<void> {
    this.#ws = this.#open();
    await new Promise<void>((resolve) => (this.#openWaiter = resolve));
    const joined = await this.#join(this.#head);
    await this.#awaitHead(joined.head);
    // An in-flight append was lost with the socket: report a conflict so the
    // coordinator rolls back and retries against the refreshed head.
    const pending = this.#pendingAppend;
    this.#pendingAppend = null;
    pending?.resolve({ ok: false, conflict: true, head: this.#head });
  }

  #join(fromSeq: number): Promise<{ head: number }> {
    return new Promise<{ head: number }>((resolve) => {
      this.#joinedWaiter = resolve;
      this.#send({
        t: "join",
        campaignId: this.#opts.campaignId,
        clientId: this.#opts.clientId,
        fromSeq,
      });
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
      case "appendOk": {
        const p = this.#pendingAppend;
        this.#pendingAppend = null;
        if (p !== null) {
          // Apply our own committed entry to the mirror NOW (stamped with the
          // server seq) so `head()` reflects the commit the moment append
          // resolves — the next submit reads a fresh base, not a stale one. The
          // later broadcast of this same seq dedupes in #applyEntry.
          this.#applyEntry({ ...p.entry, seq: msg.seq });
          p.resolve({ ok: true });
        }
        break;
      }
      case "appendConflict": {
        const p = this.#pendingAppend;
        this.#pendingAppend = null;
        const head = msg.head;
        // Resolve only once the foreign entries are in the mirror, so the
        // coordinator's #syncTo(head) finds them via entriesSince.
        void this.#awaitHead(head).then(() => p?.resolve({ ok: false, conflict: true, head }));
        break;
      }
      case "error":
        console.error("room server error:", msg.message);
        break;
    }
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

  putSnapshot(seq: number, snapshot: CampaignSnapshot): void {
    if (this.#snapshot === null || seq >= this.#snapshot.seq) this.#snapshot = { seq, snapshot };
    this.#send({ t: "putSnapshot", campaignId: this.#opts.campaignId, seq, snapshot });
  }

  append(entry: LogEntry): Promise<AppendResult> {
    return new Promise<AppendResult>((resolve) => {
      this.#pendingAppend = { resolve, entry };
      this.#send({
        t: "append",
        campaignId: this.#opts.campaignId,
        entry: entry as unknown as WireLogEntry,
      });
    });
  }

  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void {
    for (const e of this.#log) if (e.seq >= fromSeq) handler(e);
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Closes the socket without reconnecting (teardown). */
  close(): void {
    this.#closed = true;
    this.#ws.close();
  }
}
```

- [ ] **Step 5: Run the transport test**

Run: `pnpm vitest run packages/client/src/websocket-transport.test.ts`
Expected: PASS — connect-warm, append-under-CAS, peer delivery, conflict-with-catch-up, and late-join-from-snapshot all pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r run typecheck`
Expected: PASS (root + all three packages).

- [ ] **Step 7: Commit**

```bash
git add packages/client pnpm-lock.yaml
git commit -m "feat(client): WebSocketTransport with warm mirror + async CAS append"
```

---

## Task 7: `client` — seed campaign + Vite dev harness

**Files:**
- Create: `packages/client/src/seed.ts`, `packages/client/vite.config.ts`, `packages/client/index.html`, `packages/client/src/main.ts`
- Test: `packages/client/src/seed.test.ts`

**Interfaces:**
- Consumes: engine `Campaign`, `PlayerCharacter`, `Room`/`Directions`, `StatType`, `Item`, `SlotKind`, `CampaignRegistry`, `serializeCampaign`/`deserializeCampaign`, `SyncCoordinator`, `Command` (all via `wickedways/lib/...`); `WebSocketTransport` (Task 6).
- Produces: `buildSeedCampaign(): { campaign: Campaign; registry: CampaignRegistry }` and `buildSeedRegistry(): CampaignRegistry` — the shared demo campaign every client reconstructs from code (ported from the engine's test-only `buildStartedCampaign`; the test helper cannot be imported into production code). The harness (`main.ts`/`index.html`) connects a `WebSocketTransport`, builds-or-joins a `SyncCoordinator`, fires representative commands, and renders synced state as text. `main.ts` is the untested demo surface; `seed.ts` carries the tested logic.

- [ ] **Step 1: Write the failing seed test**

`packages/client/src/seed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { buildSeedCampaign, buildSeedRegistry } from "./seed.js";

describe("seed", () => {
  it("builds a started campaign with an active character", () => {
    const { campaign } = buildSeedCampaign();
    expect(campaign.started).toBe(true);
    expect(campaign.activeCharacter).toBeDefined();
  });

  it("round-trips through serialize/deserialize with the seed registry", () => {
    const { campaign } = buildSeedCampaign();
    const snap = serializeCampaign(campaign);
    const restored = deserializeCampaign(snap, { registry: buildSeedRegistry(), rng: () => 0.5 });
    expect(serializeCampaign(restored)).toEqual(snap);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/client/src/seed.test.ts`
Expected: FAIL — `./seed.js` has no exports.

- [ ] **Step 3: Implement the seed**

`packages/client/src/seed.ts`:

```ts
import { Campaign } from "wickedways/lib/campaign";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { Room, Directions, type Direction, type IRoom } from "wickedways/lib/room";
import { StatType } from "wickedways/lib/character/stats";
import { Item } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { RecipeId } from "wickedways/lib/crafting";

const WIDGET_RECIPE_ID = "widget" as RecipeId;
const WIDGET_BEHAVIOR_KEY = "widget-item";
// The Room constructor tolerates a partial/empty exits object (it iterates
// Object.entries); an empty cast keeps a room exit-free without the test-only
// `ExitsArg` alias.
const NO_EXITS = {} as Record<Direction, IRoom>;

function makeStats() {
  return { [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 };
}

function makeWidgetItem(): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Widget",
      slot: SlotKind.Hand,
      behaviorKey: WIDGET_BEHAVIOR_KEY,
    },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

function makeWidgetRecipe() {
  return { id: WIDGET_RECIPE_ID, materials: { metal: 2 }, create: makeWidgetItem };
}

/** The registry every client reconstructs from code so snapshots/deltas can hydrate. */
export function buildSeedRegistry(): CampaignRegistry {
  const registry = new CampaignRegistry();
  registry.registerRecipe(String(WIDGET_RECIPE_ID), makeWidgetRecipe());
  registry.registerItem(WIDGET_BEHAVIOR_KEY, makeWidgetItem);
  return registry;
}

/**
 * The shared demo campaign the first client seeds. Ported from the engine's
 * `buildStartedCampaign` test helper (test-only, so it cannot be imported into
 * production client code). Two PCs (Ada active, then Ben) stand in "Start", which
 * has a North exit to "Next"; the widget recipe is discovered and its materials
 * claimed so `craft` is legal.
 */
export function buildSeedCampaign(): { campaign: Campaign; registry: CampaignRegistry } {
  const campaign = new Campaign("Crypt", 10, [], { rng: () => 0.5 });
  campaign.registerArchetype({
    id: "delver" as ArchetypeId,
    name: "Delver",
    statModifiers: { [StatType.Health]: 2 },
  });

  const start = new Room("Start", "the entrance", [], NO_EXITS);
  const next = new Room("Next", "an adjoining chamber", [], NO_EXITS);
  start.addExit(Directions.North, next);

  const ada = new PlayerCharacter(campaign, "Ada", makeStats());
  ada.joinCampaign();
  ada.selectArchetype("delver" as ArchetypeId);
  ada.move(start);

  const ben = new PlayerCharacter(campaign, "Ben", makeStats());
  ben.joinCampaign();
  ben.selectArchetype("delver" as ArchetypeId);
  ben.move(start);

  campaign.discoverRecipe(makeWidgetRecipe());
  campaign.claimMaterials("seed", { metal: 2 });

  campaign.gm = ada;
  campaign.beginCampaign();

  return { campaign, registry: buildSeedRegistry() };
}
```

- [ ] **Step 4: Run the seed test**

Run: `pnpm vitest run packages/client/src/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the Vite config + harness page**

`packages/client/vite.config.ts`:

```ts
import { defineConfig } from "vite";

// Vite resolves the workspace packages (`wickedways`, `@wickedways/transport-shared`)
// via their package.json `exports`, transpiling the engine's `.ts` source directly.
export default defineConfig({
  server: { port: 5173 },
});
```

`packages/client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Wicked Ways — sync harness</title>
  </head>
  <body>
    <h1>Wicked Ways — sync harness</h1>
    <p>Open this page in two tabs (same <code>?c=</code> campaign id). Act in one; both converge.</p>
    <button id="nextPlayer">nextPlayer</button>
    <button id="moveNorth">move active North</button>
    <p id="status">connecting…</p>
    <pre id="state"></pre>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Implement the harness entrypoint**

`packages/client/src/main.ts`:

```ts
import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
import type { Command } from "wickedways/lib/sync/types";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Directions } from "wickedways/lib/room";
import { WebSocketTransport } from "./websocket-transport.js";
import { buildSeedCampaign, buildSeedRegistry } from "./seed.js";

const params = new URLSearchParams(location.search);
const campaignId = params.get("c") ?? "demo";
const clientId = crypto.randomUUID();
const url = `ws://${location.hostname}:8787`;

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

async function main(): Promise<void> {
  const transport = await WebSocketTransport.connect({ url, campaignId, clientId });
  const coordinator =
    transport.loadSnapshot() === null
      ? new SyncCoordinator({ ...buildSeedCampaign(), transport })
      : SyncCoordinator.join({ registry: buildSeedRegistry(), transport });
  coordinator.start();

  const render = (): void => {
    const c = coordinator.campaign;
    byId("state").textContent = JSON.stringify(
      { head: transport.head(), round: c.round, active: c.activeCharacter?.name ?? null, campaign: serializeCampaign(c) },
      null,
      2,
    );
  };

  const run = async (label: string, build: () => Command): Promise<void> => {
    const res = await coordinator.submit(build());
    byId("status").textContent = res.ok ? `${label}: ok (seq ${res.seq})` : `${label}: ${res.reason}`;
    render();
  };

  byId("nextPlayer").addEventListener("click", () => void run("nextPlayer", () => ({ kind: "nextPlayer" })));
  byId("moveNorth").addEventListener("click", () =>
    void run("moveNorth", () => {
      const active = coordinator.campaign.activeCharacter;
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
```

- [ ] **Step 7: Typecheck (harness included)**

Run: `pnpm -r run typecheck`
Expected: PASS — `main.ts` typechecks against the DOM lib; `seed.ts` against the engine.

- [ ] **Step 8: Manual smoke (documented, not automated)**

Run, in two terminals: `pnpm --filter @wickedways/server start` and `pnpm --filter @wickedways/client dev`.
Open `http://localhost:5173/?c=demo` in two browser tabs. Click **nextPlayer** in one tab; within ~250ms both tabs show the same `active` character and identical `campaign` JSON. This is the headline "two tabs converge" demo (manual; automated convergence is Task 9).

- [ ] **Step 9: Commit**

```bash
git add packages/client pnpm-lock.yaml
git commit -m "feat(client): seed campaign + Vite dev harness for two-tab convergence"
```

---

## Task 8: `client` — shared `SyncTransport` contract suite

**Files:**
- Test: `packages/client/src/transport-contract.test.ts`

**Interfaces:**
- Consumes: `InProcessTransport`, `SyncTransport` (`wickedways/lib/sync/transport`); `LogEntry`; `CampaignSnapshot`; `createServer`; `WebSocketTransport`.
- Produces: no new source — a single parametrized suite asserting the `SyncTransport` contract (CAS commit, stale-base conflict, subscriber delivery, ordered `entriesSince`, snapshot round-trip), run against **both** `InProcessTransport` (Spec 2) and `WebSocketTransport` + the real server. This is the headline safety net proving the real backend is behaviorally identical to the in-process one.

- [ ] **Step 1: Write the parametrized contract suite**

`packages/client/src/transport-contract.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { InProcessTransport, type SyncTransport } from "wickedways/lib/sync/transport";
import type { LogEntry } from "wickedways/lib/sync/types";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { createServer, type ServerHandle } from "@wickedways/server";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";

const entry = (seq: number, baseSeq: number): LogEntry =>
  ({ seq, baseSeq, command: { kind: "nextPlayer" }, delta: { changed: [], created: [], removed: [] } }) as unknown as LogEntry;
const snap = (): CampaignSnapshot => ({ schemaVersion: 1 }) as unknown as CampaignSnapshot;

function until(pred: () => boolean, timeoutMs = 1000): Promise<void> {
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
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

interface Backend {
  connect(): Promise<SyncTransport>;
  teardown(): Promise<void>;
}

function inProcessBackend(): Backend {
  // One shared store; every "client" is a handle on the same instance (Spec 2 model).
  const shared = new InProcessTransport();
  return { connect: () => Promise.resolve(shared), teardown: () => Promise.resolve() };
}

function webSocketBackend(): Backend {
  const nodeFactory: WebSocketFactory = (url) => new WebSocket(url) as never;
  let handle: ServerHandle | null = null;
  const transports: WebSocketTransport[] = [];
  return {
    async connect() {
      handle ??= await createServer({ port: 0 });
      const t = await WebSocketTransport.connect({
        url: `ws://127.0.0.1:${handle.port}`,
        campaignId: "contract",
        clientId: `c${transports.length}`,
        factory: nodeFactory,
      });
      transports.push(t);
      return t;
    },
    async teardown() {
      for (const t of transports) t.close();
      transports.length = 0;
      await handle?.close();
      handle = null;
    },
  };
}

function runContract(name: string, makeBackend: () => Backend): void {
  describe(`SyncTransport contract: ${name}`, () => {
    let backend: Backend;
    beforeEach(() => { backend = makeBackend(); });
    afterEach(() => backend.teardown());

    it("commits an append at head+1 and advances head", async () => {
      const a = await backend.connect();
      expect(await a.append(entry(1, 0))).toEqual({ ok: true });
      await until(() => a.head() === 1);
    });

    it("rejects a stale-base append as a conflict reporting head", async () => {
      const a = await backend.connect();
      await a.append(entry(1, 0));
      await until(() => a.head() === 1);
      expect(await a.append(entry(1, 0))).toEqual({ ok: false, conflict: true, head: 1 });
    });

    it("delivers appended entries to a subscriber on the same backend", async () => {
      const a = await backend.connect();
      const b = await backend.connect();
      const seen: number[] = [];
      b.subscribe(1, (e) => seen.push(e.seq));
      await a.append(entry(1, 0));
      await until(() => seen.includes(1));
      expect(seen).toEqual([1]);
    });

    it("returns ordered entries from entriesSince", async () => {
      const a = await backend.connect();
      await a.append(entry(1, 0));
      await until(() => a.head() === 1);
      await a.append(entry(2, 1));
      await until(() => a.head() === 2);
      await a.append(entry(3, 2));
      await until(() => a.head() === 3);
      expect(a.entriesSince(2).map((e) => e.seq)).toEqual([2, 3]);
    });

    it("round-trips a snapshot to a client that connects afterward", async () => {
      const a = await backend.connect();
      a.putSnapshot(2, snap());
      expect(a.loadSnapshot()).toEqual({ seq: 2, snapshot: snap() });
      await flush();
      const c = await backend.connect();
      expect(c.loadSnapshot()?.seq).toBe(2);
    });
  });
}

runContract("InProcessTransport", inProcessBackend);
runContract("WebSocketTransport", webSocketBackend);
```

- [ ] **Step 2: Run the contract suite**

Run: `pnpm vitest run packages/client/src/transport-contract.test.ts`
Expected: PASS — every contract assertion holds identically for `InProcessTransport` and `WebSocketTransport`.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/transport-contract.test.ts
git commit -m "test(client): shared SyncTransport contract suite (in-process + WebSocket)"
```

---

## Task 9: `client` — two-client convergence + reconnect integration

**Files:**
- Test: `packages/client/src/convergence.test.ts`

**Interfaces:**
- Consumes: `SyncCoordinator` (`wickedways/lib/sync/coordinator`); `Command`, `RecipeId`, `Directions`, `serializeCampaign`; `createServer`; `WebSocketTransport`; `buildSeedCampaign`/`buildSeedRegistry` (Task 7).
- Produces: no new source — the headline end-to-end tests. (1) Convergence: drive a representative command mix (craft → mints an item; nextPlayer; move) through `coordA` and assert `serializeCampaign(A) === serializeCampaign(B)` after each — over the real socket, proving the minted `ItemId` and all state replicate. (2) Reconnect: drop client B's socket, commit on A, and assert B auto-reconnects, backfills, and converges.

> **Scope note (for the implementer + reviewer):** the spec mentioned a snapshot-fallback heal variant. 3a's server never prunes its log, so a reconnecting client can always backfill from its last seq — the snapshot-fallback path is unreachable in 3a and is intentionally **not** tested here (it becomes reachable only once log pruning exists, a later concern). The reconnect-backfill test covers the disconnect case.

- [ ] **Step 1: Write the convergence + reconnect tests**

`packages/client/src/convergence.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { SyncCoordinator } from "wickedways/lib/sync/coordinator";
import type { Command } from "wickedways/lib/sync/types";
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
  return s as never;
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
    clientId,
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

describe("two-client convergence", () => {
  it("converges A and B after each command in a representative mix", async () => {
    handle = await createServer({ port: 0 });

    const tA = await connect("a");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush(); // let the seed snapshot reach the server before B joins

    const tB = await connect("b");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();
    expect(stateJSON(coordA)).toBe(stateJSON(coordB)); // identical from the snapshot

    const mix: { label: string; build: () => Command }[] = [
      { label: "craft", build: () => ({ kind: "craft", actorId: coordA.campaign.activeCharacter!.id, recipeId: "widget" as RecipeId }) },
      { label: "nextPlayer", build: () => ({ kind: "nextPlayer" }) },
      {
        label: "moveNorth",
        build: () => {
          const a = coordA.campaign.activeCharacter!;
          const north = a.currentRoom!.exits.get(Directions.North)!;
          return { kind: "move", actorId: a.id, roomId: north.id };
        },
      },
    ];

    for (const { label, build } of mix) {
      const res = await coordA.submit(build());
      if (!res.ok) throw new Error(`${label} rejected: ${res.reason}`);
      await until(() => stateJSON(coordA) === stateJSON(coordB));
    }
  });
});

describe("reconnect", () => {
  it("backfills and converges after B's socket drops", async () => {
    handle = await createServer({ port: 0 });

    const tA = await connect("a");
    const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
    coordA.start();
    await flush();

    const tB = await connect("b");
    const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
    coordB.start();
    await flush();

    // Drop B's underlying socket WITHOUT calling transport.close() (an
    // unintentional drop): the transport's close listener triggers reconnect.
    // B is the second client connected, so its socket is the last one created.
    const bSocket = sockets[sockets.length - 1]!;
    bSocket.close();

    // Commit on A while B is away.
    const res = await coordA.submit({ kind: "nextPlayer" });
    if (!res.ok) throw new Error(`nextPlayer rejected: ${res.reason}`);

    // B auto-reconnects, re-joins from its head, backfills the missed entry, converges.
    await until(() => stateJSON(coordA) === stateJSON(coordB));
  });
});
```

- [ ] **Step 2: Run the convergence + reconnect tests**

Run: `pnpm vitest run packages/client/src/convergence.test.ts`
Expected: PASS — A and B serialize identically after every command, and B reconverges after a socket drop.

- [ ] **Step 3: Run the whole suite + typecheck + lint**

Run: `pnpm checks`
Expected: PASS — lint, all-package typecheck, and the full test suite (engine + transport-shared + server + client) all green.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/convergence.test.ts
git commit -m "test(client): two-client convergence + reconnect over the real socket"
```

---

## Task 10: docs + final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything built in Tasks 1–9.
- Produces: a README section documenting the monorepo + how to run the multiplayer client, satisfying the living-documentation convention. (`CLAUDE.md` command references were already switched to pnpm in Task 1; the new public surfaces — `Table`, `WebSocketTransport`, the wire protocol — carry TSDoc written inline in their tasks.)

- [ ] **Step 1: Add the README section**

Append a section to `README.md` (after the existing architecture content), verbatim:

```markdown
## Multiplayer client (comms sub-spec 3a)

The repo is a pnpm workspace. The pure engine lives at the root (`src/`); three
packages under `packages/` add real-time multiplayer:

- **`@wickedways/transport-shared`** — the engine-free WebSocket wire protocol
  (message types + validators). `command`/`delta`/`snapshot` payloads are opaque.
- **`@wickedways/server`** — a self-hosted WebSocket room server. Each campaign is
  a `Table` (the server-side coordinator: an ordered compare-and-swap log + the
  latest snapshot + connected participants + broadcast). The server orders and
  relays; it never runs game logic.
- **`@wickedways/client`** — a `WebSocketTransport` implementing the engine's
  `SyncTransport` over the server, plus a minimal dev harness.

A client resolves commands locally via `SyncCoordinator` (from the engine's sync
layer) and appends `{command, delta}` to its `Table` under compare-and-swap;
replicas apply the broadcast deltas. This is the **client-resolves** topology —
the server is a dumb relay, built so the authoritative-server promotion (moving
the resolver into `Table`) is a later, contained change.

### Running it

```bash
pnpm install
pnpm --filter @wickedways/server start      # ws://127.0.0.1:8787
pnpm --filter @wickedways/client dev        # http://localhost:5173
```

Open `http://localhost:5173/?c=demo` in two tabs. Act in one (e.g. **nextPlayer**);
both converge on identical state over the wire.

### Not yet included (later sub-specs)

Seat-ownership / network auth & presence (3b), text chat (3c), and A/V over WebRTC
(3d) all build on this backend. 3a is the transport-agnostic foundation: it does no
seat validation (trusted peers) and keeps no durable state across a server restart.
```

- [ ] **Step 2: Run the full verification**

Run: `pnpm checks`
Expected: PASS — lint, all-package typecheck, and the entire test suite (engine + `transport-shared` + `server` + `client`) green.

- [ ] **Step 3: Confirm the engine build still works**

Run: `pnpm build`
Expected: the engine compiles to `dist/` via `tsconfig.build.json` (the new packages are not part of the engine build and are unaffected).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the multiplayer client monorepo + how to run it"
```

---

## Done

All ten tasks complete: pnpm monorepo, async `append`/`submit` seam, the wire
protocol, the `Table` server-side coordinator, the WebSocket server, the
`WebSocketTransport`, the seed + harness, the shared contract suite, and the
two-client convergence + reconnect tests — with the README updated. The headline
deliverable (two browser tabs converging over the wire) is demonstrable via the
harness and proven headlessly by the convergence suite.
