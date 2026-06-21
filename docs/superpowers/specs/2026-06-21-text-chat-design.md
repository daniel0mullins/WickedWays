# Comms Sub-Spec 3c — Text Chat — Design

**Date:** 2026-06-21
**Status:** Approved (pending user review)

## Problem

The comms program (Spec 3) decomposed into `3a` (client shell + real-time
backend), `3b` (identity / seat-ownership / presence), `3c` (text chat), and `3d`
(A/V via WebRTC). `3a` and `3b` shipped: there is a real WebSocket room server
that authenticates each connection to an opaque `Identity`, owns per-campaign
`Membership` (seats + GM) and presence, runs an `Authority` that derives every
delta, and persists durably through an optional `CampaignStore`. What the original
3a spec called a "dumb relay" was promoted to an **authoritative server**.

Players still cannot talk to each other. This sub-spec adds **text chat** over the
existing backend — the social layer a multiplayer tabletop needs, and the spec
whose wire backend `3d` will later reuse for A/V signaling.

## Where this sits

Dependency order is `3a → (3b, 3c) → 3d`. `3b` is done, so `3c` is unblocked.
`3c` does **not** depend on `3d`, and the parallel Play Surface (real game UI)
track consumes 3c's protocol without this spec depending on it.

## Core framing: chat is player-to-player

The single most important decision. **Chat is between players (humans /
identities), not between characters or the GM role.** Consequences that shape the
whole design:

- There is **no in-character vs out-of-character** chat, and no "spoken-as
  character" dimension. Attribution always answers "which *player* said this."
- The "GM channel" is **not** a distinct concept: the GM is just the player
  holding the GM identity (discoverable via `presence.gm`). "Message the GM" is a
  whisper to that identity. There are exactly two scopes: **room-wide** and
  **whisper**.
- Naming is **player-centric**: the UI needs a human display name per *identity*,
  not a character name.

## Decisions

Settled during brainstorming:

- **Side-channel, not the game log.** Chat is its own message family, fanned out to
  connected sockets and persisted in its own store — never in the CAS game log,
  never a `Command`/delta, zero `Authority` coupling. This mirrors how presence
  already works: chat can never desync game state, and the engine's command/delta
  types stay chat-free. The in-log alternative was rejected — it would bloat every
  snapshot and couple the engine to a comms concern for no ordering benefit chat
  actually needs.
- **Chat has its own total order.** The server assigns each message a per-room
  monotonic **`chatSeq`**, which doubles as the message **id** that edits, deletes,
  reactions, and read receipts reference. A single Node event loop per room
  serializes assignment, exactly like the game log's CAS — no locking.
- **Attribution is server-stamped and unforgeable.** Every message's `from` is the
  connection's authenticated `Identity`, set server-side, never read from the wire
  — the same principle as the server reading the actor from the command rather than
  a client envelope (`actorOf`).
- **Player names come from a host seam + a roster.** A new `displayNameFor(identity)`
  host callback gives the server each identity's display name. The server
  broadcasts a **player roster** (`{ identity, displayName, online }`) — a
  player-centric sibling of the seat-centric `presence` — which both names senders
  (players, GM, spectators alike) and powers the whisper-target picker. Messages
  carry only the unforgeable identity; the UI resolves the name from the roster.
- **Durable, with bounded backfill + pagination.** Every message is retained
  durably forever (text is cheap; unlike game state, chat cannot be compacted by a
  snapshot — each message is independent content). On join the server replays only
  the most recent window; the UI fetches older pages on demand. Retention and
  working-set are deliberately decoupled: nothing is ever destroyed, yet memory and
  join payload stay bounded.
- **Whispers are persisted and visibility-filtered.** A whisper is stored and, on
  backfill, delivered only to its two participants. The server enforces per-identity
  visibility on both live delivery and backfill.
- **Full feature set.** Beyond room/whisper send: edit/delete own messages,
  reactions, read receipts, and typing indicators are all in scope. (Typing
  overlaps the "rich presence" work the `3b` spec earmarked for a later spec; only
  typing is pulled forward here — see Out of scope.)
- **Features are authored per campaign.** Whether chat exists, and which features
  are enabled, is a `ChatPolicy` authored on the campaign template — a single-player
  campaign ships `enabled: false`. The policy lives in the campaign snapshot (see
  below) and the server enforces it authoritatively.

## Authored policy — `ChatPolicy`

Chat configuration is a property of *how a campaign is played*, so it is authored,
not host-wired. `ChatPolicy` is an engine-side **data** type (the engine never acts
on it; only the server and client read it):

```ts
interface ChatPolicy {
  enabled: boolean;       // master; false ⇒ no chat subsystem, no roster, no history
  whisper: boolean;       // private DMs (room-wide is the baseline whenever enabled)
  edit: boolean;          // edit/delete own messages
  reactions: boolean;
  readReceipts: boolean;
  typing: boolean;
  backfillWindow: number; // initial backfill size (NOT a retention cap; nothing is deleted)
}
```

- **Authored on the template.** `authoring/description.ts` gains an optional
  `chat?: ChatPolicy` on the campaign template; the assembler validates its shape.
  Authoring defaults: a multiplayer template → all features on, `backfillWindow:
  200`; a single-player template → `enabled: false`.
- **Serialized into the snapshot.** `serialization/types.ts` carries
  `chatPolicy` on the campaign snapshot. `SCHEMA_VERSION` bumps; `migrate()`
  supplies a default for pre-chat snapshots.
  - **Migration default (open for review):** legacy snapshots predate chat
    entirely (no persisted campaign uses it yet). Default is a **full all-on
    policy** with `backfillWindow: 200`, on the reasoning that those campaigns were
    multiplayer-capable; authors disable by re-authoring. The conservative
    alternative — legacy default `enabled: false` — is a one-line change if
    preferred.
- **Server enforcement (authoritative).** On load the server reads
  `snapshot.chatPolicy`. If `!enabled`, no `Chat` component is created and every
  `chat*` / `typing` / `players` message is denied. Each disabled feature denies
  its own messages (whisper off ⇒ `chatSend` with `to` is denied; `edit` off ⇒
  `chatEdit`/`chatDelete` denied; etc.).
- **Client awareness.** The client already hydrates the full snapshot, so it reads
  `chatPolicy` directly to hide disabled affordances. The server still enforces
  independently — the client is never trusted.

## Wire protocol (`transport-shared`)

New variants on the existing discriminated unions. `command`/`delta`/`snapshot`
stay opaque to the server; chat is engine-agnostic JSON.

```ts
// client → server
| { t: "chatSend";    campaignId: string; body: string; to?: Identity }   // to omitted ⇒ room-wide
| { t: "chatEdit";    campaignId: string; id: number; body: string }       // own message only
| { t: "chatDelete";  campaignId: string; id: number }                     // own message only
| { t: "chatReact";   campaignId: string; id: number; emoji: string; on: boolean }
| { t: "chatRead";    campaignId: string; upTo: number }                   // high-water chatSeq
| { t: "chatHistory"; campaignId: string; before: number }                 // page older than `before`
| { t: "typing";      campaignId: string; to?: Identity }                  // transient

// server → client
| { t: "chat";        msg: ChatMsg }                                       // live + backfill
| { t: "chatEdited";  campaignId: string; id: number; body: string; editedTs: number }
| { t: "chatDeleted"; campaignId: string; id: number }                     // tombstone
| { t: "chatReact";   campaignId: string; id: number; emoji: string; identity: Identity; on: boolean }
| { t: "chatReads";   campaignId: string; marks: { identity: Identity; upTo: number }[] }
| { t: "chatHistory"; campaignId: string; msgs: ChatMsg[]; more: boolean } // page response
| { t: "players";     campaignId: string; players: { identity: Identity; displayName: string; online: boolean }[] }
| { t: "typing";      campaignId: string; from: Identity; to?: Identity }

interface ChatMsg {
  id: number;            // chatSeq, server-assigned, monotonic per campaign
  from: Identity;        // server-stamped from the authenticated connection — unforgeable
  to?: Identity;         // present ⇒ whisper (visible only to from & to)
  body: string;
  ts: number;            // server timestamp
  editedTs?: number;
  deleted?: boolean;     // tombstone (id/order retained, body cleared)
  reactions?: { emoji: string; by: Identity[] }[];
}
```

`parseClientMsg` / `parseServerMsg` gain validators for each new variant
(matching the existing hand-rolled narrowing style; reject malformed without
crashing the room).

## Server components

- **`Chat` (one per campaign)** — beside `Table`. Owns the in-memory working set
  (recent messages, reaction sets, per-identity read high-water marks), assigns
  `chatSeq`, and enforces `ChatPolicy` and per-identity visibility on every
  delivery, backfill, and history page. Engine-agnostic; never touches `Authority`.
- **`ChatStore` seam** — parallel to `CampaignStore`: durable, **unbounded**
  append plus update-in-place (for edit/delete/reaction/read state) and a
  paginated read (`before: chatSeq`). In-memory default; an **optional sqlite**
  implementation adds a chat table to the existing `sqlite-store` package. Read
  high-water marks are persisted (unread counts survive restart). Typing is never
  stored.
- **Player roster** — new host seam `displayNameFor(identity): string` on
  `ServerOptions` (defaults to the identity string). The server broadcasts
  `players` using its existing online-count bookkeeping, on the same triggers as
  presence (join/leave) plus initial join.

## Semantics

- **Send / deliver.** Room (`to` absent) → all room subscribers. Whisper → the
  sockets of `from` and `to` only. Server stamps `id`, `from`, `ts`; persists; then
  broadcasts to the audience.
- **Backfill on join.** After the existing game backfill, the server sends, for the
  joining identity: the most recent `backfillWindow` messages it may see (all room
  messages + whispers where `from == me || to == me`), their current reactions, the
  `chatReads` marks, and the `players` roster. Older history via `chatHistory`.
- **Pagination.** `chatHistory { before }` returns up to `backfillWindow` messages
  older than `before` (visibility-filtered) with a `more` flag.
- **Edit / delete.** Server requires `msg.from === identity`. Edit updates `body` +
  `editedTs`; delete is a **tombstone** (keeps `id` and ordering, clears `body`,
  sets `deleted`) so reactions and read marks referencing it stay coherent.
  Broadcast `chatEdited` / `chatDeleted` to the message's audience.
- **Reactions.** Per-message `emoji → Set<Identity>`; `on: true/false` toggles the
  caller's membership; broadcast `chatReact` to the audience. Reactions on a whisper
  are visible only to its two participants.
- **Read receipts.** Per identity, a single per-room high-water `upTo` a `chatSeq`,
  over the messages that identity can see; broadcast as `chatReads`. **Accepted
  limitation:** because room and whisper messages share one `chatSeq` space, a
  recipient could infer that hidden whispers exist from gaps in visible ids — a
  negligible metadata leak, not message-content exposure.
- **Typing.** Transient `typing` broadcast to the scope audience (room → all;
  whisper → the target only), never stored, auto-expiring client-side.

## Error handling

- **Policy-disabled / unauthorized feature** → `denied` with a reason; the room
  never crashes.
- **Edit/delete/react on another's or a missing message** → `denied`.
- **Malformed chat message** → `error` and ignore (existing pattern).
- **Not authenticated / unknown campaign** → `denied` (existing pattern).
- **Restart** — with the sqlite `ChatStore`, history, reactions, and read marks
  survive; without a store the working set is ephemeral (consistent with the
  game-state behavior when no `CampaignStore` is supplied).

## Testing

- **`Chat` unit tests** — `chatSeq` ordering; room vs whisper visibility on
  delivery, backfill, and pagination; edit/delete authorization; tombstone
  coherence; reaction toggle; read high-water; per-feature policy enforcement
  (including master `enabled: false`).
- **`ChatStore` contract suite** — parametrized over the in-memory and sqlite
  implementations (mirrors the existing `SyncTransport` contract-suite pattern):
  append, update-in-place, visibility-filtered pagination, durability.
- **Server integration (real `ws`, ephemeral port)** — room broadcast to multiple
  clients; whisper isolation (a third client never receives it, live or on
  backfill); late-join backfill + `chatHistory` paging; sqlite restart durability;
  roster online/offline transitions; denials when a feature/policy is off.
- **CI** — new workspace tests run under the existing pnpm `checks` flow.

## Out of scope (later specs / tracks)

- **A/V / WebRTC signaling & media** — `3d`, reusing this backend.
- **Rate-limiting / anti-abuse** — deferred per the `3b` spec's out-of-scope.
- **Full rich presence** (who-is-speaking, turn spotlight, cursors) — only typing is
  pulled forward here; the rest stay in the deferred rich-presence spec.
- **Threading / replies, attachments / images, emoji-picker assets, profanity
  filtering, cross-campaign or lobby DMs, message search.**
- **The real game UI / Play Surface** — the parallel track that consumes this
  protocol.

## Docs

Per the living-documentation convention, once implemented: the README's
multiplayer section gains a "Text chat" subsection (scopes, policy, roster); the new
public surfaces (`ChatPolicy`, the chat wire protocol, `Chat`, `ChatStore`,
`displayNameFor`) get TSDoc; and the `ChatPolicy` authoring field is documented in
the authoring guide.
