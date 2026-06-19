# Comms Sub-Spec 3b — Seat Ownership / Auth / Presence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticated connections, a server-held membership model binding identities to seats, server-side enforcement that a connection may only act for seats it owns, and a presence broadcast — closing the impersonation hole 3a left open under trusted-peers.

**Architecture:** The 3a WebSocket room server gains an auth/membership layer beside its `Table` registry: a host-injected `verifyToken` binds each connection to an opaque `Identity`; a per-campaign `Membership` (`characterId → identity` + `gmIdentity`) is server-side protocol state; every `append` carries an `actor` envelope (`character` | `gm` | `join`) the server checks against membership before delegating to `Table`. Seats are self-claimed via the engine's self-service `joinCampaign`; GM control messages are admin override. One small engine change adds a terminal `denied` append outcome.

**Tech Stack:** TypeScript (strict, NodeNext), pnpm workspaces, Node 22, `ws`, Vitest. Builds on Spec 3a (merged).

**Spec:** `docs/superpowers/specs/2026-06-19-seat-ownership-presence-design.md`

## Global Constraints

- **Server-enforced ownership, server stays engine-agnostic.** The server reads only `actor` (`{kind:"character",actorId}` | `{kind:"gm"}` | `{kind:"join",characterId}`) metadata + the `Membership` map; it NEVER parses command/delta/snapshot semantics (those stay opaque `unknown`). `packages/server` still depends only on `@wickedways/transport-shared` + `ws`.
- **Abstract injected verifier.** `createServer` takes a REQUIRED `verifyToken: (token: string) => Identity | null` (host-supplied; no crypto in the engine). A `verifyToken` that throws is treated as a denial; the room never crashes.
- **Membership: server-held protocol state**, `characterId → identity` + `gmIdentity`, seeded per campaign at first reference via a REQUIRED `gmIdentityFor: (campaignId: string) => Identity`. NOT in the campaign snapshot.
- **Self-service join + GM override.** `joinCampaign` self-claims (a `join`-actor append binds the new `characterId` to the connection's identity, only if not already owned). GM-only control messages `assignSeat`/`unassignSeat`/`transferGM` are admin override.
- **Single authoritative `actorId`** lifted to the append envelope (identity metadata, not game semantics).
- **Security boundary:** 3b closes impersonation (can't act as a seat you don't own). It does NOT re-validate game legality server-side (turn order etc. stay in the client-side resolver). That is the deferred full-authoritative-server promotion.
- **One engine change only:** `AppendResult` gains `{ ok: false; denied: true; reason: string }`; `SyncCoordinator.submit` rolls the local campaign back to `before` and returns a terminal `rejected` `CommandResult` (NO retry, NO `#syncTo`). Nothing else in the Spec-2 sync layer changes.
- **`denied` (unauthorized) is distinct from `error` (malformed input).** `Identity` is an opaque `string`.
- **TypeScript strictness unchanged:** `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, `moduleResolution: NodeNext`.
- **Each task leaves the FULL `pnpm checks` green** (lint + all-package typecheck + entire suite). A contract change and all its consumers/tests land together.

---

## File Structure

**Modified:**
- `src/lib/sync/transport.ts` — `AppendResult` gains the `denied` variant.
- `src/lib/sync/coordinator.ts` — `submit` handles `denied` (rollback + terminal rejection).
- `src/lib/sync/coordinator.test.ts` — a `denied`-append test.
- `packages/transport-shared/src/index.ts` — `Actor` type; `token` on `join`; `actor` on `append`; `assignSeat`/`unassignSeat`/`transferGM` client messages; `denied` + `presence` server messages; updated validators.
- `packages/transport-shared/src/index.test.ts` — validator tests for the new messages.
- `packages/server/src/server.ts` — `verifyToken` + `gmIdentityFor` options; per-connection identity; the enforcement gate; control-message routing; presence broadcast.
- `packages/server/src/server.test.ts` — auth/ownership/control/presence integration tests; existing tests updated to pass tokens + actors.
- `packages/client/src/websocket-transport.ts` — `token` in opts; send on join/reconnect; derive `actor`; map `denied`; handle inbound `presence`.
- `packages/client/src/websocket-transport.test.ts`, `transport-contract.test.ts`, `convergence.test.ts`, `seed.ts`, `main.ts` — updated to provide a token + verifier + actors; new auth/anti-spoof/self-join/presence/reconnect-reauth assertions.
- `README.md` — auth/seat-ownership/presence subsection.

**Created:**
- `packages/server/src/membership.ts` — the `Membership` class.
- `packages/server/src/membership.test.ts` — its unit tests.

---

## Task 1: Engine — `denied` AppendResult + terminal `submit` handling

**Files:**
- Modify: `src/lib/sync/transport.ts`, `src/lib/sync/coordinator.ts`
- Test: `src/lib/sync/coordinator.test.ts`

**Interfaces:**
- Consumes: Spec 2 `SyncTransport`, `AppendResult`, `SyncCoordinator`, `CommandResult`.
- Produces: `AppendResult` gains `{ ok: false; denied: true; reason: string }`. `SyncCoordinator.submit`, on a denied append, restores the local campaign from `before` and returns `{ ok: false, rejected: true, reason }` (terminal — no retry, no `#syncTo`). `InProcessTransport` never denies (unchanged behavior). The `head`/`entriesSince`/`subscribe`/`loadSnapshot`/`putSnapshot` reads and the conflict path are unchanged.

- [ ] **Step 1: Add the `denied` variant to `AppendResult`**

In `src/lib/sync/transport.ts`, extend the type:

```ts
/** Result of {@link SyncTransport.append}: success, CAS conflict, or an authorization denial. */
export type AppendResult =
  | { ok: true }
  | { ok: false; conflict: true; head: number }
  | { ok: false; denied: true; reason: string };
```

`InProcessTransport.append` is unchanged — it only ever returns `{ ok: true }` or the conflict variant.

- [ ] **Step 2: Write the failing `submit`-denied test**

In `src/lib/sync/coordinator.test.ts`, add a transport stub that denies and assert the coordinator rolls back and reports a terminal rejection. Add near the other coordinator tests:

```ts
it("treats a denied append as a terminal rejection and restores local state", async () => {
  const { campaign, registry } = buildStartedCampaign();
  const transport = new InProcessTransport();
  // A transport that accepts the seed snapshot but denies every append.
  const denying: SyncTransport = {
    head: () => transport.head(),
    append: () => Promise.resolve({ ok: false, denied: true, reason: "not your seat" }),
    entriesSince: (n) => transport.entriesSince(n),
    subscribe: (n, h) => transport.subscribe(n, h),
    loadSnapshot: () => transport.loadSnapshot(),
    putSnapshot: (s, snap) => transport.putSnapshot(s, snap),
  };
  const coord = new SyncCoordinator({ campaign, registry, transport: denying });
  const before = serializeCampaign(coord.campaign);

  const active = coord.campaign.activeCharacter!;
  const res = await coord.submit({ kind: "move", actorId: active.id, roomId: active.currentRoom!.exits.get(Directions.North)!.id });

  expect(res).toEqual({ ok: false, rejected: true, reason: "not your seat" });
  expect(serializeCampaign(coord.campaign)).toEqual(before); // local rolled back
  expect(coord.campaign.activeCharacter!.id).toBe(active.id); // unchanged
});
```

Ensure the file imports `SyncTransport` and `Directions` (`from "../room"`) and `serializeCampaign` if not already present.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/sync/coordinator.test.ts -t "denied append"`
Expected: FAIL — `submit` currently treats `!ok` as a conflict (rolls back, fast-forwards, returns `conflict`), not a terminal `rejected`.

- [ ] **Step 4: Handle `denied` in `submit`**

In `src/lib/sync/coordinator.ts`, in `submit`, replace the post-append failure handling so a denial is terminal. The current block is:

```ts
    const res = await this.#transport.append({ seq, baseSeq, command, delta });
    if (!res.ok) {
      this.#lastApplied = baseSeq;
      this.#restore(before);
      this.#syncTo(res.head);
      return { ok: false, conflict: true, reason: `Stale base ${baseSeq}; head is ${res.head}. Retry.` };
    }
```

Replace it with:

```ts
    const res = await this.#transport.append({ seq, baseSeq, command, delta });
    if (!res.ok) {
      this.#lastApplied = baseSeq;
      this.#restore(before);
      if ("denied" in res) {
        // Authorization denial: the server rejected the commit. Roll local back to
        // pre-call state; do NOT re-sync (nothing new committed) and do NOT retry.
        return { ok: false, rejected: true, reason: res.reason };
      }
      this.#syncTo(res.head);
      return { ok: false, conflict: true, reason: `Stale base ${baseSeq}; head is ${res.head}. Retry.` };
    }
```

(`#restore(before)` already rebuilds the local campaign from the pre-call snapshot; resetting `#lastApplied = baseSeq` keeps the subscription consistent. The denied branch returns before `#syncTo`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/sync/coordinator.test.ts`
Expected: PASS — the denied test plus all existing coordinator tests (own-entry-skip, CAS conflict) still green.

- [ ] **Step 6: Full checks**

Run: `pnpm checks`
Expected: green — lint, all-package typecheck, entire suite (the 3a packages are unaffected; nothing denies yet).

- [ ] **Step 7: Commit**

```bash
git add src/lib/sync/transport.ts src/lib/sync/coordinator.ts src/lib/sync/coordinator.test.ts
git commit -m "feat(sync): terminal denied AppendResult + submit rollback (no retry)"
```

---

## Task 2: `Membership` model + `Actor`/`Identity` types

**Files:**
- Modify: `packages/transport-shared/src/index.ts` (add `Identity` + `Actor` types — additive, not yet used in any message)
- Create: `packages/server/src/membership.ts`
- Test: `packages/server/src/membership.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type Identity = string` and `type Actor = { kind: "character"; actorId: string } | { kind: "gm" } | { kind: "join"; characterId: string }` (in `@wickedways/transport-shared`). `class Membership` (in `packages/server`) with `constructor(gmIdentity)`, `get gmIdentity`, `ownerOf(characterId): Identity | null`, `seats(): [string, Identity][]`, `mayAct(identity, actor): boolean`, `claim(characterId, identity)`, `assign(characterId, identity)`, `unassign(characterId)`, `transferGM(identity)`. `mayAct`: `character` → owns the seat; `gm` → is the GM; `join` → the seat is unowned (self-claim only an unclaimed seat).

- [ ] **Step 1: Add the `Identity` + `Actor` types**

In `packages/transport-shared/src/index.ts`, after the `WireLogEntry` interface, add:

```ts
/** An authenticated identity, opaque to the engine (chosen by the host's verifier). */
export type Identity = string;

/**
 * The actor an append acts as, declared at the envelope so the server can enforce
 * ownership without parsing the opaque command. `character` = an owned seat; `gm` =
 * GM/lifecycle/NPC; `join` = self-claim a NEW seat (the joinCampaign append; the
 * client surfaces the new character's id).
 */
export type Actor =
  | { kind: "character"; actorId: string }
  | { kind: "gm" }
  | { kind: "join"; characterId: string };
```

(These are additive — no message or validator changes in this task.)

- [ ] **Step 2: Write the failing `Membership` test**

`packages/server/src/membership.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Membership } from "./membership.js";

describe("Membership", () => {
  it("starts with only the GM identity and no seats", () => {
    const m = new Membership("gm");
    expect(m.gmIdentity).toBe("gm");
    expect(m.seats()).toEqual([]);
    expect(m.ownerOf("c1")).toBeNull();
  });

  it("mayAct: character requires owning the seat", () => {
    const m = new Membership("gm");
    m.claim("c1", "ada");
    expect(m.mayAct("ada", { kind: "character", actorId: "c1" })).toBe(true);
    expect(m.mayAct("ben", { kind: "character", actorId: "c1" })).toBe(false);
    expect(m.mayAct("ada", { kind: "character", actorId: "cX" })).toBe(false); // unowned seat
  });

  it("mayAct: gm requires being the GM identity", () => {
    const m = new Membership("gm");
    expect(m.mayAct("gm", { kind: "gm" })).toBe(true);
    expect(m.mayAct("ada", { kind: "gm" })).toBe(false);
  });

  it("mayAct: join is allowed only for an unowned seat (no hijack)", () => {
    const m = new Membership("gm");
    expect(m.mayAct("ada", { kind: "join", characterId: "c1" })).toBe(true); // unowned -> may claim
    m.claim("c1", "ada");
    expect(m.mayAct("ben", { kind: "join", characterId: "c1" })).toBe(false); // already owned -> no hijack
  });

  it("claim / assign / unassign / transferGM mutate ownership", () => {
    const m = new Membership("gm");
    m.claim("c1", "ada");
    expect(m.ownerOf("c1")).toBe("ada");
    m.assign("c1", "ben"); // GM override reassigns
    expect(m.ownerOf("c1")).toBe("ben");
    m.unassign("c1");
    expect(m.ownerOf("c1")).toBeNull();
    m.transferGM("ada");
    expect(m.gmIdentity).toBe("ada");
  });

  it("seats() lists current ownerships", () => {
    const m = new Membership("gm");
    m.claim("c1", "ada");
    m.claim("c2", "ben");
    expect(new Map(m.seats())).toEqual(new Map([["c1", "ada"], ["c2", "ben"]]));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run packages/server/src/membership.test.ts`
Expected: FAIL — `./membership.js` does not exist.

- [ ] **Step 4: Implement `Membership`**

`packages/server/src/membership.ts`:

```ts
import type { Identity, Actor } from "@wickedways/transport-shared";

/**
 * One campaign's seat-ownership map: which identity owns each character seat, plus
 * the GM identity. Server-side protocol state (NOT in the campaign snapshot), so the
 * server can enforce appends without reading opaque payloads. Seeded with the GM at
 * room creation; mutated by self-service join (self-claim) and GM control messages.
 */
export class Membership {
  #gmIdentity: Identity;
  #seats = new Map<string, Identity>();

  constructor(gmIdentity: Identity) {
    this.#gmIdentity = gmIdentity;
  }

  /** The campaign's current GM identity. */
  get gmIdentity(): Identity {
    return this.#gmIdentity;
  }

  /** The owner of a character seat, or null if unowned. */
  ownerOf(characterId: string): Identity | null {
    return this.#seats.get(characterId) ?? null;
  }

  /** All seats as `[characterId, owner]` pairs. */
  seats(): [string, Identity][] {
    return [...this.#seats];
  }

  /** Whether `identity` may act as `actor`. */
  mayAct(identity: Identity, actor: Actor): boolean {
    switch (actor.kind) {
      case "character":
        return this.#seats.get(actor.actorId) === identity;
      case "gm":
        return identity === this.#gmIdentity;
      case "join":
        return !this.#seats.has(actor.characterId); // self-claim only an unowned seat
    }
  }

  /** Binds a newly-joined character to its claiming identity (self-service join). */
  claim(characterId: string, identity: Identity): void {
    this.#seats.set(characterId, identity);
  }

  /** GM override: (re)assign a seat to an identity. */
  assign(characterId: string, identity: Identity): void {
    this.#seats.set(characterId, identity);
  }

  /** GM override: free a seat. */
  unassign(characterId: string): void {
    this.#seats.delete(characterId);
  }

  /** GM override: hand the GM role to another identity. */
  transferGM(identity: Identity): void {
    this.#gmIdentity = identity;
  }
}
```

- [ ] **Step 5: Run + typecheck**

Run: `pnpm vitest run packages/server/src/membership.test.ts`, then `pnpm -r run typecheck`
Expected: PASS (6/6) and clean typecheck (the new `Identity`/`Actor` types are additive).

- [ ] **Step 6: Commit**

```bash
git add packages/transport-shared/src/index.ts packages/server/src/membership.ts packages/server/src/membership.test.ts
git commit -m "feat(server): Membership seat-ownership model + Actor/Identity wire types"
```

---

## Task 3: Authenticated identity — wire `token`/`actor`/`denied` + verify on join (no ownership enforcement yet)

This is the cohesive contract change: it threads the auth `token` and the `actor` envelope through the wire protocol, the client transport, and the server, and verifies the token on `join` — but does NOT yet enforce seat ownership on `append` (that is Task 4). It updates every existing 3a test/harness in lockstep so the full suite stays green.

**Files:**
- Modify: `packages/transport-shared/src/index.ts`, `packages/transport-shared/src/index.test.ts`
- Modify: `packages/client/src/websocket-transport.ts`
- Modify: `packages/server/src/server.ts`
- Modify (test threading): `packages/server/src/server.test.ts`, `packages/client/src/websocket-transport.test.ts`, `packages/client/src/transport-contract.test.ts`, `packages/client/src/convergence.test.ts`, `packages/client/src/main.ts`

**Interfaces:**
- Consumes: `Actor`, `Identity` (Task 2); engine `commandActorId`, `isJoinCommand` (`wickedways/lib/sync/types`); `AppendResult` denied variant (Task 1).
- Produces: wire `join` carries `token` (replaces `clientId`); `append` carries `actor: Actor`; new `{ t: "denied"; reason }` server message. `WebSocketTransport` opts take `token` (replaces `clientId`), send it on join/reconnect, derive each append's `actor`, and map a server `denied` to the `AppendResult` denied variant. `createServer` takes a REQUIRED `verifyToken: (token: string) => Identity | null`; an unauthenticated connection's `append`/`putSnapshot` is `denied`. `getSnapshot` stays pre-auth (read-only observation). NO ownership check yet.

- [ ] **Step 1: Update the wire protocol + validators**

In `packages/transport-shared/src/index.ts`: change `join` to carry `token`, add `actor` to `append`, add the `denied` server message, and add an `isActor` guard. Replace the `ClientMsg`/`ServerMsg` unions and the `parseClientMsg` `join`/`append` cases:

```ts
/** Messages a client sends to the room server. */
export type ClientMsg =
  | { t: "join"; campaignId: string; token: string; fromSeq: number }
  | { t: "append"; campaignId: string; entry: WireLogEntry; actor: Actor }
  | { t: "getSnapshot"; campaignId: string }
  | { t: "putSnapshot"; campaignId: string; seq: number; snapshot: unknown };

/** Messages the room server sends to a client. */
export type ServerMsg =
  | { t: "joined"; head: number }
  | { t: "entry"; entry: WireLogEntry }
  | { t: "appendOk"; seq: number }
  | { t: "appendConflict"; head: number }
  | { t: "snapshot"; seq: number; snapshot: unknown }
  | { t: "denied"; reason: string }
  | { t: "error"; message: string };
```

Add the actor guard (below `isWireLogEntry`):

```ts
function isActor(x: unknown): x is Actor {
  if (!isObj(x)) return false;
  if (x.kind === "character") return typeof x.actorId === "string";
  if (x.kind === "gm") return true;
  if (x.kind === "join") return typeof x.characterId === "string";
  return false;
}
```

In `parseClientMsg`, replace the `join` and `append` cases:

```ts
    case "join":
      return typeof raw.campaignId === "string" && typeof raw.token === "string" && typeof raw.fromSeq === "number"
        ? { t: "join", campaignId: raw.campaignId, token: raw.token, fromSeq: raw.fromSeq }
        : null;
    case "append":
      return typeof raw.campaignId === "string" && isWireLogEntry(raw.entry) && isActor(raw.actor)
        ? { t: "append", campaignId: raw.campaignId, entry: raw.entry, actor: raw.actor }
        : null;
```

In `parseServerMsg`, add a `denied` case (before `error`):

```ts
    case "denied":
      return typeof raw.reason === "string" ? { t: "denied", reason: raw.reason } : null;
```

- [ ] **Step 2: Update `transport-shared` tests**

In `packages/transport-shared/src/index.test.ts`: change the `join` happy-path to use `token` instead of `clientId`; change the `append` happy-path to include an `actor` (e.g. `{ kind: "gm" }`) and add an append-missing-actor rejection; add a `parseServerMsg` `denied` happy-path + a malformed one. Concretely:

```ts
  it("accepts a well-formed join (token)", () => {
    expect(parseClientMsg({ t: "join", campaignId: "c1", token: "tok", fromSeq: 0 })).toEqual({
      t: "join", campaignId: "c1", token: "tok", fromSeq: 0,
    });
    expect(parseClientMsg({ t: "join", campaignId: "c1", token: 7, fromSeq: 0 })).toBeNull();
  });

  it("accepts an append with an actor + opaque entry; rejects a missing/invalid actor", () => {
    const entry = { seq: 1, baseSeq: 0, command: { kind: "x" }, delta: { changed: [] } };
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "gm" } })).toEqual({
      t: "append", campaignId: "c1", entry, actor: { kind: "gm" },
    });
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "character", actorId: "a" } })).not.toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "join", characterId: "c" } })).not.toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry })).toBeNull(); // missing actor
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "nope" } })).toBeNull();
    expect(parseClientMsg({ t: "append", campaignId: "c1", entry, actor: { kind: "character" } })).toBeNull(); // missing actorId
  });
```

And in the `parseServerMsg` describe block:

```ts
  it("accepts denied; rejects malformed denied", () => {
    expect(parseServerMsg({ t: "denied", reason: "nope" })).toEqual({ t: "denied", reason: "nope" });
    expect(parseServerMsg({ t: "denied" })).toBeNull();
  });
```

(Remove or update any existing `join`/`append` happy-path test that still uses `clientId` / omits `actor`.)

- [ ] **Step 3: Update the `WebSocketTransport` (token + actor + denied)**

In `packages/client/src/websocket-transport.ts`:

(a) Rename the opts field `clientId` → `token` in `ConnectOpts`:

```ts
interface ConnectOpts {
  url: string;
  campaignId: string;
  token: string;
  factory?: WebSocketFactory;
}
```

(b) Add engine imports at the top (for actor derivation):

```ts
import { commandActorId, isJoinCommand } from "wickedways/lib/sync/types";
import type { Command } from "wickedways/lib/sync/types";
```

(c) Add a private actor-derivation helper and use it in `append`. Add the helper as a method:

```ts
  #actorFor(command: Command): { kind: "character"; actorId: string } | { kind: "gm" } | { kind: "join"; characterId: string } {
    if (isJoinCommand(command)) return { kind: "join", characterId: command.character.id };
    const actorId = commandActorId(command);
    return actorId === null ? { kind: "gm" } : { kind: "character", actorId };
  }
```

Change `append` to send the actor:

```ts
  append(entry: LogEntry): Promise<AppendResult> {
    return new Promise<AppendResult>((resolve) => {
      this.#pendingAppend = { resolve, entry };
      this.#send({
        t: "append",
        campaignId: this.#opts.campaignId,
        entry: entry as unknown as WireLogEntry,
        actor: this.#actorFor(entry.command),
      });
    });
  }
```

(d) Change `#join` to send the token instead of `clientId`:

```ts
  #join(fromSeq: number): Promise<{ head: number }> {
    return new Promise<{ head: number }>((resolve) => {
      this.#joinedWaiter = resolve;
      this.#send({ t: "join", campaignId: this.#opts.campaignId, token: this.#opts.token, fromSeq });
    });
  }
```

(e) Handle an inbound `denied`. In `#onMessage`'s switch, add a case:

```ts
      case "denied": {
        // A denied APPEND is terminal — resolve the in-flight append and stop.
        const p = this.#pendingAppend;
        if (p !== null) {
          this.#pendingAppend = null;
          p.resolve({ ok: false, denied: true, reason: msg.reason });
          break;
        }
        // Otherwise it's a denied HANDSHAKE (join/reconnect). Record the error, then
        // UNBLOCK the pending waiter(s) by resolving them with a dummy value, so
        // `#handshake`'s `await this.#join(...)` returns and can throw `#authError`.
        this.#authError = new Error(`auth denied: ${msg.reason}`);
        const sw = this.#snapshotWaiter;
        const jw = this.#joinedWaiter;
        this.#snapshotWaiter = null;
        this.#joinedWaiter = null;
        if (sw !== null) sw({ seq: 0, snapshot: null });
        if (jw !== null) jw({ head: 0 });
        break;
      }
```

Add a `#authError: Error | null = null` field and, in `#handshake`, after the `join` await, throw it if set so `connect()` rejects:

```ts
    const joined = await this.#join(snap.seq);
    if (this.#authError !== null) throw this.#authError;
    await this.#awaitHead(joined.head);
```

(Initialize `#authError = null` with the other private fields; reset it to `null` at the top of `#handshake`. The `WireLogEntry` import already exists.)

Apply the same guard in `#reconnect`: reset `#authError = null` before the re-`join`, and after `await this.#join(this.#head)` check it — if set, do NOT `#awaitHead`; instead resolve any in-flight `#pendingAppend` as `{ ok: false, denied: true, reason: this.#authError.message }` and stop (the connection was revoked; do not masquerade as reconnected):

```ts
    const joined = await this.#join(this.#head);
    if (this.#authError !== null) {
      const p = this.#pendingAppend;
      this.#pendingAppend = null;
      p?.resolve({ ok: false, denied: true, reason: this.#authError.message });
      return;
    }
    await this.#awaitHead(joined.head);
```

- [ ] **Step 4: Update `createServer` (verify token; gate writes on auth; no ownership yet)**

Replace `packages/server/src/server.ts` with the authenticated version (note: ownership enforcement and control messages arrive in Task 4 — this task only authenticates and gates writes on being authenticated):

```ts
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg, type Identity } from "@wickedways/transport-shared";
import { Table, type Subscriber } from "./table.js";

/** A running room server. */
export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Options for {@link createServer}. */
export interface ServerOptions {
  port?: number;
  /** Host-supplied verifier: returns the connection's identity, or null to deny. */
  verifyToken: (token: string) => Identity | null;
}

/**
 * Starts a WebSocket server: a thin adapter over a `Map<campaignId, Table>` plus an
 * auth layer. Each connection authenticates on `join` (the host's `verifyToken`);
 * writes (`append`/`putSnapshot`) require an authenticated connection. The server
 * never parses command/delta/snapshot semantics. (Seat-ownership enforcement and the
 * GM control messages are added in Task 4.)
 */
export function createServer(opts: ServerOptions): Promise<ServerHandle> {
  const tables = new Map<string, Table>();
  const tableFor = (id: string): Table => {
    let t = tables.get(id);
    if (t === undefined) { t = new Table(); tables.set(id, t); }
    return t;
  };

  const verify = (token: string): Identity | null => {
    try {
      return opts.verifyToken(token);
    } catch {
      return null; // a throwing verifier denies; the room never crashes
    }
  };

  const wss = new WebSocketServer({ port: opts.port ?? 0 });

  wss.on("connection", (ws: WebSocket) => {
    const send: Subscriber = (msg: ServerMsg) => ws.send(JSON.stringify(msg));
    const joined = new Set<string>();
    let identity: Identity | null = null;

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
        case "join": {
          const id = verify(msg.token);
          if (id === null) {
            send({ t: "denied", reason: "authentication failed" });
            return;
          }
          identity = id;
          tableFor(msg.campaignId).join(send, msg.fromSeq);
          joined.add(msg.campaignId);
          break;
        }
        case "append":
          if (identity === null) {
            send({ t: "denied", reason: "not authenticated" });
            break;
          }
          // Task 4 inserts the ownership check on msg.actor here.
          tableFor(msg.campaignId).append(msg.entry, send);
          break;
        case "getSnapshot":
          tableFor(msg.campaignId).sendSnapshot(send); // read-only observation, pre-auth allowed
          break;
        case "putSnapshot":
          if (identity === null) {
            send({ t: "denied", reason: "not authenticated" });
            break;
          }
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

Update `packages/server/src/main.ts` to pass a dev verifier: change the `createServer({ port })` call to `createServer({ port, verifyToken: (t) => t || null })` (the dev verifier treats the token string as the identity; empty token denies).

- [ ] **Step 5: Thread token + actor through the existing tests + harness**

Make the suite green again by providing tokens, a verifier, and actors everywhere the old contract was used:

- `packages/server/src/server.test.ts`: every `await createServer({ port: 0 })` → `await createServer({ port: 0, verifyToken: (t) => t || null })`. Every raw `join` payload `{ t: "join", campaignId, clientId: "a", fromSeq }` → `{ t: "join", campaignId, token: "ada", fromSeq }`. Every raw `append` payload `{ t: "append", campaignId, entry: … }` → add `actor: { kind: "gm" }` (the test entries use a `nextPlayer`-style command). Add a new test: a `join` with an empty token replies `{ t: "denied", reason: "authentication failed" }` and does not join; and an `append` before any `join` replies `{ t: "denied", reason: "not authenticated" }`.
- `packages/client/src/websocket-transport.test.ts`: every `WebSocketTransport.connect({ …, clientId: "a", … })` → `token: "ada"` (drop `clientId`). The test `entry(seq, baseSeq)` uses a `nextPlayer` command → the transport derives `{ kind: "gm" }`; no assertion changes needed beyond the opts rename.
- `packages/client/src/transport-contract.test.ts`: the `webSocketBackend()` boots `createServer({ port: 0, verifyToken: (t) => t || null })`; the per-client `connect` passes `token: \`c${transports.length}\`` (replacing `clientId`).
- `packages/client/src/convergence.test.ts`: `createServer({ port: 0, verifyToken: (t) => t || null })`; the `connect("a")`/`connect("b")` helper passes `token` (e.g. `token: clientId`). No ownership is enforced yet, so convergence still passes with any tokens.
- `packages/client/src/main.ts`: `WebSocketTransport.connect({ url, campaignId, clientId, … })` → pass `token: clientId` (the harness keeps using a random id as the dev token).

- [ ] **Step 6: Run the full suite + checks**

Run: `pnpm checks`
Expected: green — lint, all-package typecheck, and the entire suite (engine + 3 packages), including the new auth tests. Convergence/contract/transport tests pass through the authenticated (but not yet ownership-enforced) path.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-shared packages/server packages/client
git commit -m "feat(comms): authenticate connections (token on join, actor on append, denied)"
```

---

## Task 4: Ownership enforcement + GM control messages

Adds the actual authorization: wire `Membership` into `createServer`, reject appends whose `actor` the connection doesn't own, bind a seat on a committed self-service `join`, and apply the GM-only control messages.

**Files:**
- Modify: `packages/transport-shared/src/index.ts`, `packages/transport-shared/src/index.test.ts` (control messages + validators)
- Modify: `packages/server/src/table.ts`, `packages/server/src/table.test.ts` (`append` returns commit status)
- Modify: `packages/server/src/server.ts` (`gmIdentityFor`, `Membership` wiring, ownership gate, control handlers)
- Modify (test setup): `packages/server/src/server.test.ts`, `packages/client/src/transport-contract.test.ts`, `packages/client/src/convergence.test.ts`

**Interfaces:**
- Consumes: `Membership` (Task 2); `Identity`, `Actor` (Task 2).
- Produces: `ServerOptions` gains REQUIRED `gmIdentityFor: (campaignId: string) => Identity`. `Table.append` returns `{ committed: true; seq: number } | { committed: false }` (still sends the same messages). `createServer` enforces `Membership.mayAct(identity, actor)` on every append (denied otherwise), binds `characterId → identity` on a committed `join`-actor append, and applies the GM-only `assignSeat`/`unassignSeat`/`transferGM` control messages.

- [ ] **Step 1: Add the control messages to the wire protocol + validators**

In `packages/transport-shared/src/index.ts`, add three client messages to the `ClientMsg` union:

```ts
  | { t: "assignSeat"; campaignId: string; characterId: string; identity: string }
  | { t: "unassignSeat"; campaignId: string; characterId: string }
  | { t: "transferGM"; campaignId: string; identity: string }
```

In `parseClientMsg`, add their cases (before `default`):

```ts
    case "assignSeat":
      return typeof raw.campaignId === "string" && typeof raw.characterId === "string" && typeof raw.identity === "string"
        ? { t: "assignSeat", campaignId: raw.campaignId, characterId: raw.characterId, identity: raw.identity }
        : null;
    case "unassignSeat":
      return typeof raw.campaignId === "string" && typeof raw.characterId === "string"
        ? { t: "unassignSeat", campaignId: raw.campaignId, characterId: raw.characterId }
        : null;
    case "transferGM":
      return typeof raw.campaignId === "string" && typeof raw.identity === "string"
        ? { t: "transferGM", campaignId: raw.campaignId, identity: raw.identity }
        : null;
```

Add a validator test in `index.test.ts`:

```ts
  it("accepts the GM control messages; rejects malformed ones", () => {
    expect(parseClientMsg({ t: "assignSeat", campaignId: "c1", characterId: "ch", identity: "ada" })).not.toBeNull();
    expect(parseClientMsg({ t: "unassignSeat", campaignId: "c1", characterId: "ch" })).not.toBeNull();
    expect(parseClientMsg({ t: "transferGM", campaignId: "c1", identity: "ben" })).not.toBeNull();
    expect(parseClientMsg({ t: "assignSeat", campaignId: "c1", characterId: "ch" })).toBeNull(); // missing identity
  });
```

- [ ] **Step 2: `Table.append` returns commit status**

In `packages/server/src/table.ts`, change `append` to return whether it committed (it still sends the same `appendOk`/`appendConflict`/`entry` messages):

```ts
  append(entry: WireLogEntry, sender: Subscriber): { committed: true; seq: number } | { committed: false } {
    const head = this.head();
    if (entry.baseSeq !== head) {
      sender({ t: "appendConflict", head });
      return { committed: false };
    }
    const seq = head + 1;
    const committed: WireLogEntry = { ...entry, seq };
    this.#log.push(committed);
    sender({ t: "appendOk", seq });
    for (const p of this.#participants) p({ t: "entry", entry: committed });
    return { committed: true, seq };
  }
```

The existing `Table` tests assert via the subscriber messages and ignore the return, so they stay green. Add one assertion to the "commits an append" test: `expect(t.append(entry(1, 0), a.sub)).toEqual({ committed: true, seq: 1 })` and to the conflict test: `expect(t.append(entry(2, 0), a.sub)).toEqual({ committed: false })`.

- [ ] **Step 3: Enforce ownership + handle control messages in `createServer`**

In `packages/server/src/server.ts`: import `Membership`, add `gmIdentityFor` to `ServerOptions`, add a membership registry, replace the `append` case, and add the control-message cases.

Add the import and option:

```ts
import { Membership } from "./membership.js";
```
```ts
export interface ServerOptions {
  port?: number;
  verifyToken: (token: string) => Identity | null;
  /** Host-supplied: the designated GM identity for a campaign (seeds its Membership). */
  gmIdentityFor: (campaignId: string) => Identity;
}
```

Inside `createServer`, beside `tables`, add the membership registry:

```ts
  const memberships = new Map<string, Membership>();
  const membershipFor = (id: string): Membership => {
    let m = memberships.get(id);
    if (m === undefined) { m = new Membership(opts.gmIdentityFor(id)); memberships.set(id, m); }
    return m;
  };
```

Replace the `append` case and add the control cases:

```ts
        case "append": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const m = membershipFor(msg.campaignId);
          if (!m.mayAct(identity, msg.actor)) { send({ t: "denied", reason: "not authorized for this seat" }); break; }
          const result = tableFor(msg.campaignId).append(msg.entry, send);
          if (msg.actor.kind === "join" && result.committed) {
            m.claim(msg.actor.characterId, identity); // self-service seat claim, on commit
            // Task 5 broadcasts presence here.
          }
          break;
        }
        case "assignSeat":
        case "unassignSeat":
        case "transferGM": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const m = membershipFor(msg.campaignId);
          if (identity !== m.gmIdentity) { send({ t: "denied", reason: "GM only" }); break; }
          if (msg.t === "assignSeat") m.assign(msg.characterId, msg.identity);
          else if (msg.t === "unassignSeat") m.unassign(msg.characterId);
          else m.transferGM(msg.identity);
          // Task 5 broadcasts presence here.
          break;
        }
```

(The `getSnapshot`/`putSnapshot`/`join` cases are unchanged from Task 3.)

- [ ] **Step 4: Write the ownership + control tests**

In `packages/server/src/server.test.ts`, update every `createServer` call to add `gmIdentityFor: () => "gm"` (alongside the `verifyToken` from Task 3), then add tests using the raw `ws` client + `collect` helper:

```ts
it("denies an append whose seat the connection does not own", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
  const a = await open(handle.port);
  a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(a, 1); // joined
  const denied = collect(a, 1);
  // "ada" does not own character "cBen"
  a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "character", actorId: "cBen" } }));
  expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
  a.close();
});

it("self-service join binds the seat; a second join for it is denied (no hijack)", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
  const a = await open(handle.port);
  a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(a, 1);
  // ada self-claims character "cAda" via a join-actor append
  const ok = collect(a, 2); // appendOk + entry
  a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "join", characterId: "cAda" } }));
  await ok;
  // now ada owns cAda and can act as it
  const act = collect(a, 2);
  a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "character", actorId: "cAda" } }));
  await act;
  // ben cannot hijack cAda via join
  const b = await open(handle.port);
  b.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ben", fromSeq: 0 }));
  await collect(b, 2); // joined + backfill entry 1
  const hijack = collect(b, 1);
  b.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 2), actor: { kind: "join", characterId: "cAda" } }));
  expect(await hijack).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
  a.close(); b.close();
});

it("gm actions require the GM identity; non-GM control messages are denied", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
  const g = await open(handle.port);
  g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
  await collect(g, 1);
  const gmOk = collect(g, 2); // appendOk + entry
  g.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
  await gmOk;

  const p = await open(handle.port);
  p.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(p, 2); // joined + backfill
  const denyGm = collect(p, 1);
  p.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "gm" } }));
  expect(await denyGm).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
  const denyCtl = collect(p, 1);
  p.send(JSON.stringify({ t: "assignSeat", campaignId: "c1", characterId: "cX", identity: "ada" }));
  expect(await denyCtl).toEqual([{ t: "denied", reason: "GM only" }]);
  g.close(); p.close();
});

it("GM assignSeat lets the assigned identity act; unassign revokes", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
  const g = await open(handle.port);
  g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
  await collect(g, 1);
  g.send(JSON.stringify({ t: "assignSeat", campaignId: "c1", characterId: "cAda", identity: "ada" }));

  const a = await open(handle.port);
  a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(a, 1);
  const ok = collect(a, 2);
  a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "character", actorId: "cAda" } }));
  await ok; // ada can act as cAda

  g.send(JSON.stringify({ t: "unassignSeat", campaignId: "c1", characterId: "cAda" }));
  const denied = collect(a, 1);
  a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "character", actorId: "cAda" } }));
  expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
  g.close(); a.close();
});
```

- [ ] **Step 5: Keep the client integration tests green under enforcement**

The contract + convergence tests now run through the ownership gate, so their identities must own what they act as:

- `packages/client/src/transport-contract.test.ts`: the `webSocketBackend()` boots `createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "c0" })`. The contract entries use a `nextPlayer` command → a `{kind:"gm"}` actor, and the only appending client is the first one (`token: "c0"`), which is now the GM — so its gm-actor appends are authorized.
- `packages/client/src/convergence.test.ts`: boot `createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" })` and connect A with `token: "ada"`, so A's identity is the GM (authorized for the `nextPlayer` gm-action and to assign seats). The seed characters (Ada, Ben) pre-exist in the campaign — created in-engine by `buildSeedCampaign`, NOT via the sync `join` flow — so the server's `Membership` has no seats for them. Grant them to `"ada"` with a **test-only raw GM `ws` connection** before the command loop (no new transport API):

  ```ts
  // After coordA + coordB are constructed and started:
  const ids = coordA.campaign.party.map((p) => p.id); // the seed character ids (Ada, Ben)
  const gmWs = new WebSocket(`ws://127.0.0.1:${handle.port}`);
  await new Promise<void>((r) => gmWs.addEventListener("open", () => r()));
  gmWs.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
  for (const id of ids) gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: id, identity: "ada" }));
  await flush(); // let the server apply the assignments before the first append
  gmWs.close();
  ```

  Now A (identity `"ada"`) owns both seats and is the GM, so every command in the mix (craft as Ada → character actor; nextPlayer → gm actor; move as Ben → character actor) is authorized and convergence holds under enforcement.

- [ ] **Step 6: Full checks**

Run: `pnpm checks`
Expected: green — ownership/anti-spoof/self-join/control tests pass; contract + convergence pass under enforcement with their membership set up.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-shared packages/server packages/client
git commit -m "feat(server): enforce seat ownership + GM control messages (assign/unassign/transferGM)"
```

---

## Task 5: Presence

Adds the presence view: the server tracks online identities per campaign and broadcasts a presence snapshot on connect / disconnect / seat-claim / control change; the client surfaces it.

**Files:**
- Modify: `packages/transport-shared/src/index.ts`, `packages/transport-shared/src/index.test.ts` (presence message + validator)
- Modify: `packages/server/src/table.ts`, `packages/server/src/table.test.ts` (a `broadcast` method)
- Modify: `packages/server/src/server.ts` (online tracking + presence build + broadcasts)
- Modify: `packages/client/src/websocket-transport.ts` (surface inbound presence)
- Modify: `packages/server/src/server.test.ts` (presence integration tests)

**Interfaces:**
- Consumes: `Membership` (Task 2), the control + join flows (Task 4).
- Produces: wire `{ t: "presence"; campaignId; seats: PresenceEntry[]; gm: { identity: string; online: boolean } }` with `PresenceEntry = { characterId: string; owner: string | null; online: boolean }`. `Table.broadcast(msg: ServerMsg): void`. `createServer` broadcasts presence on connect / disconnect / committed `join`-claim / `assignSeat` / `unassignSeat` / `transferGM`. `WebSocketTransport` opts gain optional `onPresence?: (p: PresenceMsg) => void` and a `latestPresence` getter.

- [ ] **Step 1: Add the presence message + validator**

In `packages/transport-shared/src/index.ts`, add the type and a guard, and the `ServerMsg` member:

```ts
/** One seat's presence: its owner (or null if unclaimed) and whether that owner is online. */
export interface PresenceEntry { characterId: string; owner: string | null; online: boolean }
```

Add `| { t: "presence"; campaignId: string; seats: PresenceEntry[]; gm: { identity: string; online: boolean } }` to `ServerMsg`. Add a guard:

```ts
function isPresenceEntry(x: unknown): x is PresenceEntry {
  return isObj(x) && typeof x.characterId === "string"
    && (x.owner === null || typeof x.owner === "string") && typeof x.online === "boolean";
}
```

In `parseServerMsg`, add a `presence` case:

```ts
    case "presence":
      return typeof raw.campaignId === "string" && Array.isArray(raw.seats) && raw.seats.every(isPresenceEntry)
        && isObj(raw.gm) && typeof raw.gm.identity === "string" && typeof raw.gm.online === "boolean"
        ? { t: "presence", campaignId: raw.campaignId, seats: raw.seats as PresenceEntry[], gm: { identity: raw.gm.identity, online: raw.gm.online } }
        : null;
```

Add a validator test in `index.test.ts`:

```ts
  it("accepts presence; rejects malformed presence", () => {
    const p = { t: "presence", campaignId: "c1", seats: [{ characterId: "ch", owner: "ada", online: true }], gm: { identity: "gm", online: false } };
    expect(parseServerMsg(p)).toEqual(p);
    expect(parseServerMsg({ t: "presence", campaignId: "c1", seats: [{ characterId: "ch" }], gm: { identity: "gm", online: true } })).toBeNull();
  });
```

- [ ] **Step 2: Add `Table.broadcast`**

In `packages/server/src/table.ts`, add a method (reuses the participant set):

```ts
  /** Sends a server message to every current participant (used for presence). */
  broadcast(msg: ServerMsg): void {
    for (const p of this.#participants) p(msg);
  }
```

Add a `Table` test: join two recorders, `t.broadcast({ t: "error", message: "x" })`, assert both received it.

- [ ] **Step 3: Track online identities + broadcast presence in `createServer`**

In `packages/server/src/server.ts`, add online tracking and a presence builder, and broadcast on the lifecycle events. Add `PresenceEntry` to the import from `@wickedways/transport-shared`. Inside `createServer`, after `membershipFor`:

```ts
  const online = new Map<string, Map<Identity, number>>();
  const bump = (campaignId: string, id: Identity, delta: number): void => {
    let map = online.get(campaignId);
    if (map === undefined) { map = new Map(); online.set(campaignId, map); }
    const n = (map.get(id) ?? 0) + delta;
    if (n <= 0) map.delete(id); else map.set(id, n);
  };
  const presenceOf = (campaignId: string): ServerMsg => {
    const m = membershipFor(campaignId);
    const onlineMap = online.get(campaignId);
    const isOnline = (id: Identity): boolean => (onlineMap?.get(id) ?? 0) > 0;
    const seats: PresenceEntry[] = m.seats().map(([characterId, owner]) => ({ characterId, owner, online: isOnline(owner) }));
    return { t: "presence", campaignId, seats, gm: { identity: m.gmIdentity, online: isOnline(m.gmIdentity) } };
  };
  const broadcastPresence = (campaignId: string): void => tableFor(campaignId).broadcast(presenceOf(campaignId));
```

In the `join` case, after `joined.add(msg.campaignId)`: `bump(msg.campaignId, id, 1); broadcastPresence(msg.campaignId);` (the joiner is already a participant, so the broadcast reaches it too).

In the committed-`join`-claim branch of `append` (Task 4), after `m.claim(...)`: `broadcastPresence(msg.campaignId);`.

In each control-message branch (Task 4), after applying the change: `broadcastPresence(msg.campaignId);`.

In the `ws.on("close")` handler, replace the body with (decrement, leave, then broadcast to the rest):

```ts
    ws.on("close", () => {
      for (const id of joined) {
        tables.get(id)?.leave(send);
        if (identity !== null) bump(id, identity, -1);
        broadcastPresence(id);
      }
    });
```

- [ ] **Step 4: Surface presence on the client**

In `packages/client/src/websocket-transport.ts`: import `type { ServerMsg }` is already implied via `parseServerMsg`; add `PresenceMsg` handling. Add to `ConnectOpts`: `onPresence?: (p: Extract<import("@wickedways/transport-shared").ServerMsg, { t: "presence" }>) => void;` (or import the `ServerMsg` type and define a `PresenceMsg` alias). Add a private `#latestPresence` field initialized `null`, a public getter `latestPresence`, and in `#onMessage`'s switch a case:

```ts
      case "presence":
        this.#latestPresence = msg;
        this.#opts.onPresence?.(msg);
        break;
```

```ts
  get latestPresence(): Extract<ServerMsg, { t: "presence" }> | null {
    return this.#latestPresence;
  }
```

(Import `ServerMsg` as a type from `@wickedways/transport-shared`.)

- [ ] **Step 5: Presence integration tests**

In `packages/server/src/server.test.ts` add (using the raw `ws` client + `collect`):

```ts
it("broadcasts presence on join, seat-claim, and disconnect", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
  const g = await open(handle.port);
  const gMsgs = collect(g, 2); // joined + presence
  g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
  const got = await gMsgs;
  expect(got).toContainEqual({ t: "presence", campaignId: "c1", seats: [], gm: { identity: "gm", online: true } });

  // ada joins + self-claims cAda -> presence shows the seat owned + online
  const a = await open(handle.port);
  a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(a, 2); // joined + presence
  const claimP = collect(g, 3); // appendOk-not-for-g; g receives entry + presence... collect presence
  a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "join", characterId: "cAda" } }));
  const after = await claimP;
  expect(after).toContainEqual({ t: "presence", campaignId: "c1", seats: [{ characterId: "cAda", owner: "ada", online: true }], gm: { identity: "gm", online: true } });
  g.close(); a.close();
});

it("an identity stays online while any of its connections is live", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
  const g = await open(handle.port);
  g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
  await collect(g, 2);
  const a1 = await open(handle.port);
  a1.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(a1, 2);
  const a2 = await open(handle.port);
  a2.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
  await collect(a2, 2);
  // assign a seat to ada so presence has an entry to report online state for
  g.send(JSON.stringify({ t: "assignSeat", campaignId: "c1", characterId: "cAda", identity: "ada" }));
  await collect(g, 1); // presence
  const afterClose = collect(g, 1); // presence after a1 closes
  a1.close();
  const p = await afterClose;
  expect(p).toEqual([{ t: "presence", campaignId: "c1", seats: [{ characterId: "cAda", owner: "ada", online: true }], gm: { identity: "gm", online: true } }]); // still online via a2
  g.close(); a2.close();
});
```

(The exact `collect(...)` counts may need a small adjustment to match message ordering — the implementer should verify against the actual stream and adjust counts, keeping the assertions on the presence payloads.)

- [ ] **Step 6: Full checks**

Run: `pnpm checks`
Expected: green — presence broadcasts on connect/claim/disconnect, multi-connection online semantics, all prior tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-shared packages/server packages/client
git commit -m "feat(comms): presence — online identities + seat map broadcast"
```

---

## Task 6: End-to-end — authenticated two-owner convergence, anti-spoof, reconnect-reauth

The headline integration tests for 3b, through the full stack (engine + coordinator + transport + auth + ownership + server). New file so the 3a `convergence.test.ts` stays focused.

**Files:**
- Create: `packages/client/src/auth-convergence.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `buildSeedCampaign`/`buildSeedRegistry`; `WebSocketTransport`; `SyncCoordinator`; `createServer`.

- [ ] **Step 1: Write the end-to-end auth tests**

`packages/client/src/auth-convergence.test.ts` — uses the same helpers as `convergence.test.ts` (a `sockets`-capturing `factory`, `flush`, `until`, `stateJSON`). Adapt them (copy the helper block from `convergence.test.ts`), then:

```ts
// Two authenticated owners: A = "ada" (GM + owns Ada seat), B = "ben" (owns Ben seat).
it("two authenticated owners converge; each only acts for its own seat", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" });

  const tA = await connect("ada"); // token === identity
  const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
  coordA.start();
  await flush(); // seed snapshot reaches the server

  const tB = await connect("ben");
  const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
  coordB.start();

  // A (GM) assigns the two seed seats to their owners via a raw GM ws connection.
  const [adaId, benId] = coordA.campaign.party.map((p) => p.id);
  const gmWs = new WebSocket(`ws://127.0.0.1:${handle.port}`);
  await new Promise<void>((r) => gmWs.addEventListener("open", () => r()));
  gmWs.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
  gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: adaId, identity: "ada" }));
  gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: benId, identity: "ben" }));
  await flush();
  gmWs.close();

  // Ada is active first: A crafts (Ada, owned), then A nextPlayer (gm), then B moves (Ben, owned).
  const r1 = await coordA.submit({ kind: "craft", actorId: adaId, recipeId: "widget" as RecipeId });
  if (!r1.ok) throw new Error(`craft: ${r1.reason}`);
  await until(() => stateJSON(coordA) === stateJSON(coordB));

  const r2 = await coordA.submit({ kind: "nextPlayer" });
  if (!r2.ok) throw new Error(`nextPlayer: ${r2.reason}`);
  await until(() => stateJSON(coordA) === stateJSON(coordB));

  const north = coordB.campaign.activeCharacter!.currentRoom!.exits.get(Directions.North)!;
  const r3 = await coordB.submit({ kind: "move", actorId: benId, roomId: north.id });
  if (!r3.ok) throw new Error(`move(ben): ${r3.reason}`);
  await until(() => stateJSON(coordA) === stateJSON(coordB));
});

// Anti-spoof: B (owns only Ben) tries to act as Ada -> server denies -> B rolled back, A unaffected.
it("a client cannot act for a seat it does not own; no divergence results", async () => {
  handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "ada" });
  const tA = await connect("ada");
  const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
  coordA.start();
  await flush();
  const tB = await connect("ben");
  const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
  coordB.start();

  const [adaId, benId] = coordA.campaign.party.map((p) => p.id);
  const gmWs = new WebSocket(`ws://127.0.0.1:${handle.port}`);
  await new Promise<void>((r) => gmWs.addEventListener("open", () => r()));
  gmWs.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
  gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: adaId, identity: "ada" }));
  gmWs.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: benId, identity: "ben" }));
  await flush();
  gmWs.close();

  const beforeA = stateJSON(coordA);
  // Ada is active; B (ben) tries to move Ada (B's resolver accepts since Ada is active, but ben != owner of Ada).
  const adaNorth = coordB.campaign.activeCharacter!.currentRoom!.exits.get(Directions.North)!;
  const res = await coordB.submit({ kind: "move", actorId: adaId, roomId: adaNorth.id });
  expect(res.ok).toBe(false);
  expect("rejected" in res && res.rejected).toBe(true); // terminal denial, not a retryable conflict
  await flush();
  expect(stateJSON(coordA)).toBe(beforeA);          // A untouched
  expect(stateJSON(coordB)).toBe(stateJSON(coordA)); // B rolled back to convergence
});

// Reconnect re-auth: a valid token reconnects and reconverges; a revoked token is denied.
it("reconnect re-authenticates; a revoked token is denied on reconnect", async () => {
  let revoked = false;
  handle = await createServer({
    port: 0,
    verifyToken: (t) => (t === "ben" && revoked ? null : t || null),
    gmIdentityFor: () => "ada",
  });
  const tA = await connect("ada");
  const coordA = new SyncCoordinator({ ...buildSeedCampaign(), transport: tA });
  coordA.start();
  await flush();
  const tB = await connect("ben");
  const coordB = SyncCoordinator.join({ registry: buildSeedRegistry(), transport: tB });
  coordB.start();
  await flush();

  // Drop B's socket (unintentional) -> reconnect re-sends join with token "ben" -> still valid -> reconverges.
  sockets[sockets.length - 1]!.close();
  const r = await coordA.submit({ kind: "nextPlayer" });
  if (!r.ok) throw new Error(`nextPlayer: ${r.reason}`);
  await until(() => stateJSON(coordA) === stateJSON(coordB)); // B backfilled after re-auth

  // Now revoke ben's token and drop again -> reconnect join is denied (surfaced; no reconverge).
  revoked = true;
  const headBefore = tB.head();
  sockets[sockets.length - 1]!.close();
  await flush();
  await coordA.submit({ kind: "nextPlayer" }); // commits on the server while B is denied
  await flush();
  expect(tB.head()).toBe(headBefore); // B never re-joined, so it received no further entries
});
```

(`nextPlayer` is a `gm` action — A's identity "ada" is the GM, so it is authorized. The implementer imports `RecipeId` from `wickedways/lib/crafting` and `Directions` from `wickedways/lib/room`, and copies the `connect`/`flush`/`until`/`stateJSON`/`afterEach` helper block from `convergence.test.ts`. Verify timing against the real stream; the assertions are on convergence/denial, not exact message counts.)

- [ ] **Step 2: Run + full checks**

Run: `pnpm vitest run packages/client/src/auth-convergence.test.ts`, then `pnpm checks`
Expected: green — two-owner convergence, anti-spoof no-divergence, reconnect re-auth (valid + revoked) all pass; whole suite green. If a test is timing-flaky, investigate (don't blind-retry) and report.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/auth-convergence.test.ts
git commit -m "test(client): authenticated two-owner convergence, anti-spoof, reconnect re-auth"
```

---

## Task 7: Docs + final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything in Tasks 1–6.
- Produces: a README subsection documenting auth / seat-ownership / presence.

- [ ] **Step 1: Add the README subsection**

In `README.md`, inside the existing "Multiplayer client" section, append:

```markdown
### Authentication, seat ownership & presence (sub-spec 3b)

Connections authenticate and the server enforces who may act for whom:

- **`createServer({ verifyToken, gmIdentityFor })`** — `verifyToken(token) -> Identity | null`
  is host-supplied (the engine bakes in no crypto); `gmIdentityFor(campaignId)` seeds each
  campaign's GM. A client presents its `token` on `join` (and on every reconnect).
- **Seat ownership** — the server holds a per-campaign `Membership` (`characterId -> identity`
  + `gmIdentity`). Every `append` carries an `actor` envelope (`character` | `gm` | `join`) the
  server checks against membership; an append for a seat the connection does not own is
  `denied` (the submitting client's `submit` returns a terminal rejection and rolls back). The
  server reads only this id metadata — never command semantics — so it stays engine-agnostic.
- **Self-service join + GM override** — `joinCampaign` self-claims (binds the new character to
  the joiner's identity, if unowned). The GM-only `assignSeat`/`unassignSeat`/`transferGM`
  control messages handle reassignment, removal, and GM hand-off.
- **Presence** — the server broadcasts a `presence` snapshot (seat owners + who is online + GM
  online) on connect / disconnect / claim / control change. An identity is online while any of
  its connections is live.

**Boundary:** 3b closes impersonation (you cannot act for a seat you do not own). It does not
re-validate game legality server-side (turn order etc. stay in the client-side resolver) — that
is the deferred authoritative-server promotion.
```

- [ ] **Step 2: Full verification**

Run: `pnpm checks`, then `pnpm build`
Expected: `pnpm checks` green (lint + all-package typecheck + entire suite); `pnpm build` compiles the engine to `dist/` clean (the packages are not part of the engine build).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document auth, seat ownership, and presence (sub-spec 3b)"
```

---

## Done

All seven tasks complete: the terminal `denied` engine seam, the `Membership` model, authenticated connections (token + actor envelope), server-enforced seat ownership + GM control messages, presence, the authenticated end-to-end suite (two-owner convergence, anti-spoof, reconnect re-auth), and docs. The impersonation hole 3a left open is closed; the server still reads only id metadata, preserving the engine-agnostic boundary and the authoritative-server promotion seam.
