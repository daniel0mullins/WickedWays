# PR Preview Deployments (Coolify) — Design

**Date:** 2026-07-10
**Status:** Approved, **deferred** — do not implement until the trigger below is met.
**Trigger to resume:** the Dioxus fullstack server (axum + Dioxus, linking `wickedways-core`) is merged to `main`.

## Purpose

Give every pull request an isolated, ephemeral preview deployment on our self-hosted
Coolify instance, so reviewers can exercise the multiplayer game (server + web client)
for a branch at a real URL before merge.

## Key decision: wait for Dioxus

The current stack is a Vite/TypeScript client (`packages/client`) plus a Node
WebSocket server (`packages/server`). Setting up previews against it now would produce
throwaway build config, because the frontend is being migrated to **Dioxus** and the
server to **Rust (axum) fullstack**. We therefore **defer** the preview-deploy work and
target the post-migration architecture directly.

### Why the current stack is not preview-ready (context for the migration)

- `packages/server` is a pure `ws` `WebSocketServer({ port })` — it binds its own TCP
  port and serves **no** HTTP/static content, so it cannot serve a client on one origin.
- `packages/client/src/main.ts` hardcodes `ws://${location.hostname}:8787` — plain `ws://`
  on a fixed port. Over an HTTPS preview domain this is mixed-content blocked and the port
  does not exist. The Dioxus client must instead derive a **same-origin, scheme-aware**
  URL from `window.location` (`wss://<host>/ws` on HTTPS).

## Target architecture — one Rust fullstack binary

A single **axum + Dioxus-fullstack** binary that links `wickedways-core` directly and, on
**one port**, both:

- serves the Dioxus web app (bundled WASM + static assets), and
- handles the multiplayer **WebSocket** endpoint via an axum WS upgrade on a route (e.g. `/ws`).

Consequences:

- **One port → one Coolify resource → one preview URL per PR.**
- The browser opens its socket **same-origin** (`wss://<host>/ws`), scheme/host derived
  from `window.location`. No hardcoded host/port/scheme.
- **Store is ephemeral in-memory** per preview (no `DB_PATH`, no attached volume), so each
  PR boots a clean slate and teardown leaves nothing behind.
- Binds `0.0.0.0:$PORT`, reading `PORT` from the environment (Coolify injects it).

## Build — multi-stage Dockerfile (not Nixpacks)

A hand-written Dockerfile, matching what the repo's `.dockerignore` already anticipates
(it excludes `target/`, the wasm `pkg*` dirs, and expects a clean Coolify checkout):

- **Builder stage:** Rust toolchain + `dx` CLI + the `wasm32-unknown-unknown` target;
  `dx build --release` (fullstack) produces the server binary and the bundled web assets.
- **Runtime stage:** slim/distroless base; copy the binary + assets; `EXPOSE`/bind `$PORT`;
  `CMD` runs the binary.

**Rationale for Dockerfile over Nixpacks:** Nixpacks (Node provider, no Rust) was only the
right call for the pure-TS stack, which we are no longer targeting. Once Rust + `dx` + a
wasm target are required, a Dockerfile gives far more control over the toolchain than
coaxing Nixpacks' Rust provider.

## Coolify configuration (at execution time)

- **Source:** GitHub App is already connected, so Coolify receives PR
  `opened` / `synchronize` / `closed` webhooks for the repo.
- On the application resource: **enable "Preview Deployments."**
- **Preview domain — decide at execution time, two options:**
  - **Wildcard subdomain (recommended if we own a domain):** add a wildcard DNS record
    `*.preview.<yourdomain>` → Coolify host; Coolify assigns `pr-{{pr_id}}.preview.<yourdomain>`
    per PR with real TLS.
  - **sslip.io / IP-based (zero DNS):** Coolify's built-in `<ip>.sslip.io`-style hostnames.
    Works immediately, uglier URLs — fine to start with.
- **Per-preview environment:** `PORT` (Coolify-injected), **no** `DB_PATH` (keeps the store
  ephemeral), plus any auth / GM-identity vars the server needs.
- **Auto-teardown:** Coolify removes the preview when the PR closes/merges (default).
- **Optional hardening:** restrict previews to **non-fork** PRs to avoid exposing secrets
  to fork branches.

## Readiness checklist — what the Dioxus migration must deliver

1. A single binary serving the app **and** the WebSocket endpoint on one `PORT`.
2. A **same-origin, scheme-aware** WS URL in the client (`wss` on HTTPS, derived from
   `window.location`).
3. **Ephemeral** in-memory store by default (no `DB_PATH`/volume required).
4. A Dockerfile that builds from a **clean checkout** (Coolify clones fresh — no host
   artifacts baked in; host-built `pkg*`/`target` must not be required).

## Out of scope

- Previews for the separate PHP marketing page (`landing/`).
- Persistent per-preview databases / seeded data beyond the ephemeral demo genesis.
- Previews for the single-player play surface (`packages/play`, `play-runtime`) — these
  use the wasm `pkg*` build and are a different deployable.

## Next step (when triggered)

When the Dioxus fullstack server is merged to `main`, invoke the `writing-plans` skill to
turn this design into an implementation plan (Dockerfile authoring, same-origin WS wiring,
Coolify resource + preview config, first end-to-end PR preview verification).
