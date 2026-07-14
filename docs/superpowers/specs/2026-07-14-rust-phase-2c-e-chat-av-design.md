# Rust Phase 2c — Sub-project E: chat + A/V (design)

**Date:** 2026-07-14
**Status:** design
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md) (sub-project **E**)
**Depends on:** C (the axum server message loop + `ServerOptions`) and D (the Dioxus client shell).
**Ports:** server `packages/server/src/{chat,chat-store,sqlite-chat-store,call}.ts`; client
`packages/client/src/{chat,call}.ts`; the chat/call arms of `packages/transport-shared/src/index.ts`.

## Goal

Port the text-chat and A/V side-channels to Rust. These are **engine-agnostic** — they sit beside the
game `Table`/`Authority` and never touch it — so E is conventional state-machine work, not a
differential port. The server owns chat persistence + policy + WebRTC signal **relay**; the client
owns chat state + the WebRTC **mesh**. E slots its message arms into the loop C established.

## Server side

### `Chat` (port `chat.ts`)

A per-campaign side-channel: assigns the monotonic `chat_seq` (message id), enforces `ChatPolicy` +
whisper visibility, and persists through a `ChatStore`. Port verbatim:

- `send(from, body, to)` — whisper gate, trim, empty/`MAX_CHAT_BODY` (2000) checks, stamp
  `{id: ++seq, from, to, body, ts}`, append. Returns the stamped msg or a `ChatDeny`.
- `edit` / `remove` — owner-only, policy-gated; `remove` tombstones (id/order kept, body cleared,
  `deleted: true`).
- `react` — toggle an identity in an emoji's set via the shared `apply_reaction` helper; **skip the
  write when nothing changed** but still return the message (idempotent broadcast).
- `read` — high-water mark, `readReceipts`-gated; returns all room marks.
- `backfill(identity)` / `history(identity, before)` — the recent visible window + pagination.
- `load` seeds `chat_seq` above the store's `max_id`.

### `ChatStore` (port `chat-store.ts` + `sqlite-chat-store.ts`)

The trait (`append`/`update`/`recent`/`page`/`get`/`max_id`/`set_read`/`reads`) with the **whisper-
visibility invariant** baked into `recent`/`page` (visible iff room-wide or identity is `from`/`to`).
`InMemoryChatStore` (default) + `SqliteChatStore` (already audited injection-safe — the Rust port keeps
the parameterized-statement discipline and the two-table schema `chat_messages` / `chat_reads`).

### `Call` (port `call.ts`)

Per-campaign A/V membership: tracks `peerId → {identity, muted, cameraOn}`, enforces `AvPolicy`
(`enabled` + `maxParticipants` hard gates; `video` validated in `setState`), builds the `CallPeer`
roster. Pure state — **the server owns signal relay and delivery**; `Call` never sees a socket.
`join` (idempotent re-join), `leave`, `setState`, `roster`, `identityOf`.

### Signal relay

The server's `signal` arm is a pure **relay**: forward `{from: peerId, data}` to the target peer by
`peerId` (`server.ts:444`). The server never terminates media and hands out `iceServers` (default a
public STUN) on `callJoined`. This is a handful of lines in C's message loop; E supplies the `Chat`/
`Call` state and the delivery routing (`deliverChat` room-vs-whisper fan-out, `callBroadcast` over the
roster).

## Client side (in the Dioxus app)

### `ChatClient` (port `chat.ts`)

Pure state, no socket/DOM: messages kept **sorted by id** (so backfill + pagination interleave),
`players`, `reads`, `typing`. `on_server_msg` folds each chat/players/typing arm; `send` builds the
`chatSend` `ClientMsg`. Trivial Rust port.

### `CallClient` (port `call.ts`) — the one hard part

A browser WebRTC **full-mesh** coordinator: one peer connection per other participant,
perfect-negotiation with a deterministic single-offerer role (**impolite = lexicographically-lesser
`peerId`**), driven by injected seams (`create_peer` / `get_local_stream` / `send_signal` /
`on_remote_stream` / `on_peers`). The negotiation *logic* ports cleanly to Rust; the actual
`RTCPeerConnection` binding is **`web-sys`/`wasm-bindgen`** in the Dioxus WASM app — the primary
new-technology risk in all of 2c. Carry the current scope limit forward: **audio-baseline, glare
handling omitted** (the deterministic offerer avoids glare for the initial exchange; mid-call video
renegotiation is a documented future path, `call.ts:93`).

Keep the seam interface (`RtcPeerLike`, `CallClientOpts`) so the mesh logic is unit-testable in Rust
without a real browser — mirror the TS injection pattern exactly.

## Wire arms (extend `transport-shared`)

E adds these to the shared serde types (skeletons already relayed opaquely by C):

- **client → server:** `chatSend`/`chatHistory`/`chatEdit`/`chatDelete`/`chatReact`/`chatRead`/`typing`;
  `callJoin`/`callLeave`/`signal`/`avState`.
- **server → client:** `chat`/`chatHistory`/`chatEdited`/`chatDeleted`/`chatReact`/`chatReads`/`typing`;
  `callJoined`/`callPeers`/`signal`; plus the `players` roster.

## Integration into C's loop

C's `ServerOptions` gains `chat_store`, `ice_servers`, and `display_name_for`; its message switch gains
the chat/call arms (each auth-gated, policy-gated, then routed). Presence/roster already exist in C;
E adds the `subsByIdentity` index (whisper delivery) and the `peersByCampaign` index (call delivery)
and the `Chat`/`Call` per-campaign maps. All of this is additive to the skeleton C defines.

## The oracle / gate

Conventional (no differential oracle):

1. **Ported behavioral tests** — `chat.test.ts` / chat-store contract tests / `call.test.ts` re-expressed
   in Rust: policy gating, whisper visibility, edit/delete/react ownership + idempotence, read marks,
   call capacity/video gates, roster.
2. **`SqliteChatStore` parity** — the ported store passes the same store-contract tests; parameterized
   statements only (no injection regression).
3. **E2E** — two Dioxus clients exchange room + whisper messages and establish an audio call through the
   axum relay (the WebRTC path validated in a real browser via the existing Playwright harness).

## Constraints held

- **Engine-agnostic** — chat/AV never read or mutate the game `Authority`/snapshot; a chat outage never
  affects game state and vice versa.
- **Server relays media signalling only** — no media termination; peers connect directly (mesh).
- **Injection-safe persistence** — the `SqliteChatStore` port keeps parameterized statements.
- **Panic-free** — a disabled policy, bad body, or non-owner edit is a `denied`, never a panic.

## Sequencing

E is last before F: it needs C's loop and D's client shell. Slices: (1) `Chat` + `ChatStore` +
`SqliteChatStore` + the chat arms in C + `ChatClient` in D; (2) `Call` + signal relay + the call arms +
`CallClient` (the `web-sys` WebRTC binding) in D; (3) the e2e call/chat parity pass.

## Next step

Land C and D first; then plan E slice 1 (text chat, entirely Rust state + storage, no WebRTC) to derisk
ahead of the `web-sys` A/V work in slice 2.
