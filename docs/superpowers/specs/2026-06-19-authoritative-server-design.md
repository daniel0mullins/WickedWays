# Authoritative Server — Design

> Comms program, follow-up to sub-spec 3b. Closes the cross-seat impersonation
> gap that 3a and 3b deliberately left open under their trusted-peers /
> envelope-ownership models.

**Status:** approved, ready for implementation planning
**Date:** 2026-06-19
**Builds on:** Spec 1 (serialization), Spec 2 (sync), 3a (WS room server + `Table` +
`WebSocketTransport`), 3b (authentication + seat ownership + presence).

---

## Goal

Make the server the **sole authority** over campaign state: the client submits a
*command*, the server runs the engine to resolve it into the authoritative
*delta*, and broadcasts that delta to every replica. Because the client never
supplies a delta — and the server checks ownership against the actor it reads
*out of the command itself* — a hostile authenticated seat-holder can no longer
forge a delta that acts as another seat. Impersonation becomes structurally
impossible, not merely policy-gated.

## Background: what changes and why

Through 3a and 3b the server was deliberately **engine-agnostic** — a dumb
ordered-log relay. The client resolved a command into a delta and submitted
both; the server enforced only authentication (3b) and envelope-ownership (3b),
then relayed the opaque payload; replicas applied the client-supplied delta
verbatim. The 3b adversarial deep review established the precise limit of that
model: a hostile seat-holder can submit an `actor` envelope it legitimately owns
while carrying a `command`/`delta` that mutates *another* seat, and replicas
apply it verbatim. The server, treating the payload as opaque, cannot tell.

The only durable fix is to stop trusting the client's delta. That requires the
server to **run engine logic** — to re-derive the delta from the command itself.
This spec makes that move.

## Decisions (locked during brainstorming)

1. **Authority model — server computes deltas.** The client sends the *command
   only*. The server resolves it authoritatively and broadcasts the resulting
   delta. The client's delta is gone from the wire entirely.
2. **Client behaviour — wait-for-authority, no prediction.** The client shows a
   pending state and updates only when the server's authoritative delta arrives.
   No optimistic self-apply, no rollback, no rng guessing. Acceptable because the
   engine is turn-based (high latency tolerance).
3. **No rng change in this spec.** The server's `Authority` draws from its own
   injected `rng` (it is the sole authority, so its rng need not be reproducible
   on clients). Deterministic/serialized rng + client-side prediction is a
   **separate follow-up spec** (see "Explicitly out of scope"), seeded by the
   shared-seed PRNG idea.
4. **Structure — a unified `Authority` behind the transport.** Resolution
   (authorize → apply → diff) is extracted from `SyncCoordinator` into one
   engine-side `Authority` unit that holds the campaign. The in-process transport
   hosts an in-process `Authority`; the WS server hosts the same one. One
   resolution implementation, two host sites. The coordinator's optimistic-apply,
   `#restore`, and CAS-conflict machinery are *removed*.
5. **Drop the `actor` envelope.** The server reads the command and derives the
   actor itself (`commandActorId` / `isJoinCommand`), checking `Membership.mayAct`
   directly. There is no separate envelope to keep in sync with the command —
   which structurally closes the desync class the 3b deep review flagged.
6. **Remove client `putSnapshot`.** The server holds the state, so it snapshots
   its *own* authoritative campaign every N commits and serves late-joiners from
   it. No client uploads a checkpoint (this also retires 3b's GM-gated-putSnapshot
   patch — it is moot once clients cannot snapshot at all).
7. **Genesis — host-injected `genesisFor(campaignId)`.** `createServer` gains
   `genesisFor(campaignId) => CampaignSnapshot | null` plus a required
   `registry: CampaignRegistry`. The server builds the `Authority` lazily from the
   host's trusted store on first join; an unknown `campaignId` is denied. The
   server's initial truth never comes from a client. The dev harness wires
   `genesisFor` to the existing seed.

---

## Architecture

```
single-player:   App ─ Coordinator ─ InProcessTransport ─ Authority(local)
multiplayer:     App ─ Coordinator ─ WebSocketTransport ─[ws]─ Server ─ Authority(per campaign)
```

Both topologies are the same shape: **submit a command to an authority, apply
the delta it returns.** The only difference is whether that authority is
in-process or across a socket. This is exactly the "promotion seam" 3a/3b
described — now realised.

### Authority (new — `src/lib/sync/authority.ts`)

Engine-side. Holds a live `Campaign`, the committed `LogEntry[]`, the current
`seq`, and the injected `rng`. Absorbs the resolve → apply → diff orchestration
that `SyncCoordinator.submit` performs today, including the
restore-on-`ProceduralViolation` rollback.

```ts
class Authority {
  constructor(
    genesis: CampaignSnapshot,
    opts: { registry: CampaignRegistry; rng?: () => number; snapshotEvery?: number },
  );

  /** authorize → apply (restore from `before` on throw) → diff → seq++ → append to log */
  submit(command: Command):
    | { ok: true; seq: number; delta: Delta }
    | { ok: false; denied: true; reason: string };

  head(): number;
  snapshot(): { seq: number; snapshot: CampaignSnapshot }; // current authoritative state
  entriesSince(seq: number): LogEntry[];                   // late-join replay
}
```

`submit` flow:
1. `authorize(campaign, command)` → if `{ ok: false, reason }`, return `denied`.
2. Serialize `before` (snapshot + index).
3. `apply(campaign, command, index)` — mutates in place. On `ProceduralViolation`,
   restore the campaign from `before` and return `denied` with the message. The
   authoritative state is never left half-mutated.
4. `diff(before, after)` → `delta`.
5. `seq = head() + 1`; append `{ seq, baseSeq: seq - 1, command, delta }` to the log.
6. Return `{ ok: true, seq, delta }`.

`Resolver`, `DeltaComputer`, and `DeltaApplier` are **unchanged internally** —
only their call sites move from the coordinator into `Authority`.

### SyncCoordinator (simplified — `src/lib/sync/coordinator.ts`)

No longer holds `resolver` or `deltaComputer`. It holds a replica `Campaign`,
the `DeltaApplier`, and the transport. `submit` becomes a thin pass-through:

```ts
async submit(command: Command): Promise<CommandResult> {
  const res = await this.#transport.submit(command);
  if (!res.ok) return { ok: false, rejected: true, reason: res.reason };
  this.#applier.apply(this.#local, res.delta, { registry: this.#registry, rng: this.#rng });
  this.#lastApplied = res.seq;
  return { ok: true, seq: res.seq, delta: res.delta };
}
```

Removed: optimistic self-apply, `#restore`, the CAS-conflict branch and retry.
Retained: `#onRemote` (apply other participants' deltas) and `#syncTo` (heal a
sequence gap / late-join). The submitter's own broadcast echo, if any, is skipped
by the existing `entry.seq <= #lastApplied` guard.

> Note: `CommandResult`'s `conflict` variant is removed (no CAS conflicts exist
> with a single writer). `rejected` now covers every server denial — including a
> command that became illegal because another command was ordered first.

### Transport interface (`src/lib/sync/transport.ts`)

```ts
interface SyncTransport {
  submit(command: Command): Promise<SubmitResult>;
  subscribe(onEntry: (entry: LogEntry) => void): void;
  head(): number;
  entriesSince(seq: number): LogEntry[];
  // late-join snapshot accessor as needed by the coordinator
}

type SubmitResult =
  | { ok: true; seq: number; delta: Delta }
  | { ok: false; denied: true; reason: string };
```

`append(entry): AppendResult` is replaced by `submit(command): SubmitResult`.

- **InProcessTransport** wraps an `Authority`. `submit` calls
  `authority.submit(command)`; on success it broadcasts the new entry to the
  *other* subscribers and returns `{ seq, delta }`; on denial it returns the
  denial. Single-player has exactly one subscriber, so the broadcast is a no-op.
- **WebSocketTransport** sends `submit{ command }`, awaits `committed{ seq, delta }`
  or `denied{ reason }`, and resolves the `SubmitResult` accordingly.

### Wire protocol (`packages/transport-shared`)

ClientMsg:
- `append{ entry, actor }` → **`submit{ campaignId, command }`** — the `entry`
  (delta) and `actor` envelope are both gone; the server derives the actor from
  the command.
- **Remove `putSnapshot`.**
- Keep `join{ campaignId, token, fromSeq }`, `assignSeat`, `unassignSeat`,
  `transferGM`.

ServerMsg:
- `appendOk{ seq }` → **`committed{ seq, delta }`** — sent only to the submitter,
  carrying the authoritative delta so the submitter applies it like any replica.
- Keep **`entry{ seq, delta }`** — broadcast to the *other* participants.
- Keep `denied{ reason }`, `presence{…}`, `joined{ head }`, and the server→client
  `snapshot{ seq, snapshot }` (sent on join).
- **Remove `appendConflict`** — one writer, no CAS.

`command` and `delta` cross the wire as serialized JSON (the same shapes
serialization Spec 1 already round-trips). The server deserializes the command to
the typed `Command` before handing it to `Authority`.

### Server (`packages/server`)

`createServer({ port?, verifyToken, gmIdentityFor, registry, genesisFor })`. The
server now **imports the engine** (a new workspace dependency on `wickedways`)
for `Authority`, the `Command` type, `commandActorId`/`isJoinCommand`, and the
`CampaignRegistry` type.

`Table` is reworked from an opaque CAS log into the per-campaign coordinator of:
- an **`Authority`**, built lazily on first join from `genesisFor(campaignId)` +
  `registry` (if `genesisFor` returns `null`, the join is denied);
- the 3b **`Membership`** (seat → identity, GM identity);
- the participant set and presence accounting (3b, unchanged).

`submit` handler:
1. Authenticated? else `denied`.
2. Derive the actor from the command (`isJoinCommand` → `join`; else
   `commandActorId` → `character` | `gm`).
3. `Membership.mayAct(identity, actor)`? else `denied`.
4. `Authority.submit(command)`:
   - `denied` → forward `denied{ reason }` to the submitter.
   - `committed` → send `committed{ seq, delta }` to the submitter and
     `entry{ seq, delta }` to every other participant. If the command was a join
     and it committed, `Membership.claim(characterId, identity)` and broadcast
     presence (3b behaviour, now keyed off the authoritative commit).

The server snapshots its own `Authority` state every N commits and serves
late-joiners from it (`snapshot` + `entry` replay + `joined{ head }`).

### Client (`packages/client`)

`WebSocketTransport`: `submit(command)` replaces `append(entry)`; `#actorFor`
and the envelope are removed; `putSnapshot` is removed; map `committed`/`denied`
to `SubmitResult`. Token, auth-denial handling, reconnect re-auth, and presence
(`onPresence`/`latestPresence`) from 3b are unchanged. The `seed` and dev harness
gain a `genesisFor` wiring so the server can build its `Authority`.

---

## Data flow (multiplayer, happy path)

1. App → `coordinator.submit(command)`.
2. Coordinator → `transport.submit(command)` → ws `submit{ command }`.
3. Server: authenticate → actor-from-command → `mayAct` → `Authority.submit`:
   authorize → apply (restore on throw) → diff → `seq++` → log append.
4. Server → `committed{ seq, delta }` to the submitter; `entry{ seq, delta }` to
   the other participants.
5. Submitter's coordinator applies the delta (`DeltaApplier`), sets
   `#lastApplied = seq`, resolves `{ ok: true, seq, delta }`.
6. Other coordinators apply the same delta via `#onRemote`.

All replicas — submitter included — reach byte-identical state because they all
apply the **same** server-derived delta.

## Late-join

`join{ campaignId, token, fromSeq }` → verify token → obtain/lazily-build the
campaign's `Authority` → send the server's current authoritative
`snapshot{ seq, snapshot }` (if the joiner is behind) followed by `entry` for
each committed delta since, then `joined{ head }`. Presence bump + broadcast as in
3b.

## Error handling

Every failure returns `denied{ reason }`; the authoritative state is never left
mutated:
- unknown campaign (`genesisFor` → `null`) → denied;
- not authenticated → denied;
- not the seat owner (command-derived actor fails `mayAct`) → denied;
- illegal command — `authorize` fails (lifecycle/turn/GM) or `apply` throws
  `ProceduralViolation` (Authority restores from `before`) → denied.

There are no CAS conflicts: the server is the only writer and orders commands by
arrival. A command that has become illegal because another command was ordered
first simply fails `authorize`/`apply` and is denied — the client surfaces "that
action is no longer valid."

## Security outcome

- **Impersonation is structurally impossible.** The client supplies only a
  command; the server computes the delta. There is no client delta to forge and
  no envelope to desync from the command. `mayAct` is checked against the
  command-derived actor, so a command carrying another seat's `actorId` is denied
  before it can commit.
- **Single source of truth.** With one writer there is no divergence window; all
  replicas apply the identical authoritative delta.
- **The GM still authors the world,** but genesis comes from the host's trusted
  `genesisFor`, not from any client — so even the initial state is not
  client-asserted.

## Testing

- **Authority unit tests:** authorize-denial, apply-success delta shape,
  restore-on-`ProceduralViolation` (state unchanged after a throw), monotonic
  `seq`, `entriesSince`, `snapshot`.
- **Coordinator tests (simplified):** `submit` applies the returned delta;
  denial yields `{ rejected, reason }`; `#onRemote` applies others' deltas;
  `#syncTo` heals a gap. Assert the removed optimistic/CAS paths are gone.
- **InProcessTransport tests:** an `Authority`-backed transport drives the
  existing single-player flows; the existing `src/integration.test.ts` passes
  after rewiring (behaviour preserved).
- **Server tests:** authoritative `submit` commits and broadcasts; ownership
  enforced from the command-derived actor; unknown campaign denied; illegal
  command denied with the engine's reason and no state change; late-join replays
  from the server snapshot; presence preserved from 3b.
- **Anti-impersonation test:** an authenticated seat-holder submits a command
  whose `actorId` is another seat → `denied`; no replica state changes.
- **Convergence test:** two authenticated clients each submit legal commands for
  their own seats; every replica (including each submitter) is byte-identical
  after each commit.

## Explicitly out of scope (deferred to a follow-up spec)

- **Client-side prediction** and the **deterministic / serialized rng** change
  that would enable it (shared-seed PRNG with `seq`-keyed draws to neutralise
  action-reordering foreknowledge). `rng` stays as today: re-injected fresh, not
  serialized; the server's `Authority` draws from its own rng.
- **Durable membership / campaign persistence** across server restarts (still a
  3b-era deferral; `genesisFor` is the seam a persistent store would plug into).
- **Per-identity seat caps, map pruning, transferGM lockout recovery** — carried
  forward from 3b's known-limitations list.

## Files (anticipated)

- Create: `src/lib/sync/authority.ts` (+ test).
- Modify: `src/lib/sync/coordinator.ts` (simplify), `src/lib/sync/transport.ts`
  (interface), the in-process transport, `src/lib/sync/types.ts` (CommandResult /
  SubmitResult).
- Modify: `packages/transport-shared/src/index.ts` (wire protocol).
- Modify: `packages/server/src/{server,table}.ts` (host the Authority; new engine
  dep), reuse `membership.ts`.
- Modify: `packages/client/src/websocket-transport.ts` (submit; drop
  envelope/putSnapshot), `seed` + harness (`genesisFor` wiring).
- Update: `README.md` (replace the trusted-peers/envelope-ownership boundary
  description with the authoritative-server guarantee).
