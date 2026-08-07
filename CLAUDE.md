# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A turn-based tabletop horror-RPG engine written in **Rust** (`crates/`), shipped as a
wasm-compiled web client. **`README.md` is the authoritative architecture document** — read it
before non-trivial changes; this file adds only the operational and convention notes not spelled
out there.

The workspace:

| Crate | Role |
|---|---|
| `wickedways-core` | The engine: world state, turn loop, combat, mechanics, the ops DSL, sync. `no_std`-capable (`alloc`-only without the `std` feature). |
| `wickedways-author` | Compiles the TOML campaign-author format into a description + catalog. |
| `wickedways-assemble` | Assembles a description + catalog (+ seated party) into a genesis snapshot. |
| `wickedways-wasm` | The wasm-bindgen boundary: the stateful `Authority` handle; JSON strings cross the seam. |
| `wickedways-transport` | The multiplayer wire protocol (serde only, engine-free). |
| `wickedways-server` | The axum room server: per-campaign table actors, seat auth, SQLite persistence. |
| `wickedways-web` | The Dioxus web client (the shipped product; see the root `Dockerfile`). |
| `wickedways-studio` | Campaign Studio: the standalone graphical campaign-authoring app (Dioxus wasm; spec in `docs/campaign-studio-spec.md`). |

The TypeScript engine and its packages have been deleted; the golden corpus under
`conformance/fixtures/` (goldens + TOML campaign sources) is all that remains of `conformance/`.
`landing/` is a separate PHP marketing page, not part of the engine build. The root
`package.json` exists only for the VitePress docs site.

`desktop/` is a deliberately workspace-**excluded** shell crate: it runs `wickedways-web`
(with its `native-app` feature) in a native dioxus-desktop window. Keep it excluded — it is
the only crate linking system GTK/WebKit, and pulling it (or `dioxus/desktop`) into the
workspace or into a `wickedways-web` feature would make every workspace-wide gate need those
system packages. The `native-app` feature itself must stay dependency-light for the same
reason; desktop-only window services are injected via `platform::install_desktop_hooks`.

## Commands

```bash
cargo test --workspace                                          # all suites, incl. the golden gates
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt --all --check
cargo build -p wickedways-core --no-default-features            # the no_std gate
cargo clippy -p wickedways-web --all-targets --target wasm32-unknown-unknown -- -D warnings
cargo build -p wickedways-web --target wasm32-unknown-unknown   # the shipped client
cargo build -p wickedways-studio --target wasm32-unknown-unknown # Campaign Studio (authoring app)
cargo run --manifest-path desktop/Cargo.toml                    # the native desktop shell (workspace-excluded; needs GTK/WebKit dev libs on Linux)
cd desktop && dx bundle --release --platform desktop            # desktop installers (.deb/.rpm/AppImage | .app/.dmg | .msi) — dioxus-cli 0.6.3; --platform is required
cargo clippy -p wickedways-wasm --target wasm32-unknown-unknown --features conformance -- -D warnings
pnpm docs:build                                                 # VitePress docs site (docs-site/)
```

Run one test file or filter by name:

```bash
cargo test -p wickedways-core combat                 # tests whose path/name matches
cargo test -p wickedways-assemble --test replay_gate # one integration-test binary
```

The toolchain is pinned in `rust-toolchain.toml`; CI (`.github/workflows/checks.yml`) must use
the same version or fmt/clippy drift.

## Goldens: Rust + TOML are the source of truth

`conformance/fixtures/` holds the golden corpus — see its `README.md` for the file classes.
Four gates pin engine/compiler/assembler/sync behavior against committed goldens, which are
**regression pins of the Rust engine's own output**. When a change intentionally alters
behavior, regenerate deliberately and review the diff like code:

```bash
UPDATE_GOLDENS=1 cargo test -p wickedways-author   --test gate
UPDATE_GOLDENS=1 cargo test -p wickedways-assemble --test goldens
UPDATE_GOLDENS=1 cargo test -p wickedways-assemble --test replay_gate
UPDATE_GOLDENS=1 cargo test -p wickedways-assemble --test sync_gate
```

Regeneration is deterministic — a second run must produce a zero git diff. Never hand-edit a
golden.

## Conventions that affect edits

- **The Behavior-trait pattern.** Every extensible family follows the same idiom: a trait
  (`MechanicOp`, `ExitBehavior`, `SceneBehavior`, `VictoryConditionBehavior`, `ItemBehavior`,
  `FormationBehavior`, `CardBehavior`), a native `key → &'static dyn` registry lookup, a
  `Resolved{Native,Scripted}` enum falling back to `catalog.behaviors` scripts, and load-time
  shape validation in `validate_mechanics`. Extend this pattern rather than inline-matching new
  behavior. One deliberate exception: item behaviors validate **weaker** than the rest — an
  item's `behavior_key` doubles as its catalog descriptor key, so a missing behavior entry is
  legal (never make `validate_mechanics` reject a plain item).
- **Illegal operations throw `ProceduralViolation`** — lifecycle guards are intentional. New
  illegal-state transitions should do the same. Some error strings are replay-observable; the
  golden gates will catch accidental changes.
- **All randomness flows through `World.rng`** (mulberry32, seeded). Never draw from anywhere
  else — replay determinism and the golden gates depend on it. `Date`/wall-clock access does not
  exist in the engine.
- **`no_std` discipline in `wickedways-core`.** Use `alloc::` imports (`alloc::format!`,
  `alloc::string::ToString`, …) — a bare `std::` path compiles under default features but breaks
  the `--no-default-features` build (CI gates it).
- **Serialization stability.** Snapshot/wire shapes are pinned by the golden gates and saved
  campaigns. Field renames or serde-attribute changes on snapshot types are behavior changes —
  expect golden diffs and treat them accordingly.
- **Lints.** The workspace lint policy lives in the root `Cargo.toml` (`[workspace.lints]`,
  individually enabled pedantic subset); every crate opts in via `lints.workspace = true`. Keep
  `-D warnings` clean; a new `#[allow]` needs a one-line justification comment.

## After adding a feature

Update `README.md` (and relevant rustdoc) to reflect new mechanics before considering the work
done — the README is living documentation. If the feature changes engine-observable behavior,
regenerate the goldens deliberately (see above) and include the reviewed diff in the same
change.
