# The Rust Ecosystem Tour (30–40 minutes)

**Title:** *One Engine, Written in Rust: a working tour of the Rust
ecosystem*

**Audience:** engineers curious about — or evaluating — Rust. No Rust
experience assumed; familiarity with some package ecosystem (npm, pip) is
leaned on for analogies. Unlike talks 01–04, this one is *about* the Rust,
using Wicked Ways as the case study — every ecosystem concept is shown
doing a real job in a shipped codebase, never taught abstractly.
**Format:** 5 parts, ≈32 minutes of talk + Q&A. Speaker notes are the
script; timing checkpoints and cut order at the end.

---

## Part 1 — Why Rust exists (4 min)

*Visual: one slide, three claims — no garbage collector, "if it compiles
it usually works," one language from browser to bare metal.*

Open with the receipt, then promise to earn it: Wicked Ways is a turn-based
horror RPG whose single Rust codebase ships as a browser game (compiled to
WebAssembly), a desktop app, a multiplayer server, a graphical campaign
editor, and the firmware-side controller for a physical e-ink board on a
serial cable. One language, one repository, five very different targets —
and the goal of this talk is that by the end, every tool that makes that
normal will have been introduced doing its actual job in this repo.

The pitch itself, honestly compressed:

1. **Memory safety without a garbage collector.** Rust's compiler proves at
   build time that memory is used correctly — the crash-and-exploit class C
   and C++ programs carry is ruled out, without the runtime pauses and
   overhead of a garbage-collected language. That's why it fits both a
   web server and a microcontroller.
2. **"If it compiles, it usually works."** The type system is expressive
   enough that whole categories of bugs become compile errors. You fight
   the compiler up front instead of the debugger at 2 a.m. (Part 4 shows
   this doing *architectural* work, not just catching typos.)
3. **One language, an absurd range.** The same source compiles natively for
   your OS, to WebAssembly for the browser, and for bare-metal targets with
   no operating system at all. Most stacks need three languages for that
   spread; this repo needs zero glue.

## Part 2 — The toolbox: the ecosystem in nine beats (9 min)

*Visual: one icon row per beat; each beat names the tool, the npm/pip
analogy, and the file in this repo where it's earning its keep.*

This is the "brief introduction to Rust's ecosystem" proper. Nine beats,
each ~1 minute, each pointing at a real file:

1. **`rustup` — the toolchain installer.** Like `nvm`/`pyenv`, but
   official and universal: it installs Rust versions, extra components,
   and cross-compilation targets. You will never manually download a
   compiler.
2. **`rust-toolchain.toml` — the version pin.** This repo pins Rust
   `1.94.1`, with the war story right in the comment: formatter output and
   lint sets shift between releases, so CI and laptops must agree on the
   version or the style gates disagree with each other. Drop this file in
   the repo root and `rustup` auto-installs the right toolchain for anyone
   who clones. (Analogy: `.nvmrc`, but it actually installs.)
3. **`cargo` — the everything-tool.** Package manager, build system, test
   runner, doc generator, benchmark runner — one tool, no webpack/babel/
   jest/setuptools constellation to assemble. In this repo,
   `cargo test --workspace` doesn't just run unit tests — it runs the four
   golden gates that pin the whole engine's behavior byte-for-byte.
4. **crates.io + `Cargo.lock` — dependencies, reproducibly.** The package
   registry (npm's registry, PyPI) plus a committed lockfile, so every
   machine builds the identical dependency tree. Rust libraries are called
   *crates* — hence the `crates/` directory naming you'll see everywhere.
5. **Workspaces — one repo, many crates, one build.** A workspace is a set
   of crates sharing one lockfile and one target directory (think npm/pnpm
   workspaces or a monorepo). This repo is a **ten-crate workspace**: the
   engine core, the campaign compiler, the assembler, the wire protocol,
   the server, the wasm boundary, the web client, the physical-tabletop
   bridge, the hardware controller, and the new graphical campaign studio.
   `cargo test --workspace` sweeps all of them in one command.
6. **The workspace *exclusion* — the nuance beat.** One crate, the native
   desktop shell, is deliberately *outside* the workspace — and the root
   `Cargo.toml` says why in a comment: it's the only crate linking the
   system GUI stack (GTK/WebKit on Linux), and excluding it means nobody
   needs those system packages installed to build or test everything else.
   Ecosystem lesson: workspace membership is a boundary you *design*.
7. **Features — compile-time configuration.** A crate can expose named
   feature flags that compile code in or out. Three real ones here: the
   core's `std` feature (off = the engine builds with no operating-system
   assumptions at all — the embedded story); the web client's
   `native-app` feature (the same UI crate becomes the desktop app); and
   the sweetest small one — `serde_json`'s `float_roundtrip` feature,
   turned on because the default float parser can re-parse a serialized
   number to a *slightly different* number, which broke byte-exact replay.
   One line in `Cargo.toml` fixed a determinism bug. That's the ecosystem
   working.
8. **Targets — same code, different worlds.** `rustup` installs target
   definitions; `cargo build --target wasm32-unknown-unknown` compiles the
   web client and studio for the browser. CI builds the core with
   `--no-default-features` (the no-OS configuration) *and* the wasm
   targets on every commit — the "one language, many worlds" claim is a
   gated build, not a slide.
9. **`clippy` + `rustfmt` — mechanized review culture.** The official
   linter (hundreds of lints, from correctness to style) and the official
   formatter, both run in CI here with warnings promoted to errors
   (`-D warnings`). The root `Cargo.toml` shows the grown-up version: a
   shared `[workspace.lints]` policy where individual pedantic lints are
   enabled by name — with comments explaining which noisy ones were
   deliberately left out. Lint policy as reviewed, documented code.

## Part 3 — The ecosystem in the wild: the crate map (13 min)

*Visual: the hub diagram — the engine core in the center, each marquee
library annotated on the crate that uses it.*

Now the libraries everyone actually reaches for, each shown at its job
site. For each: what it is, why it's the ecosystem default, what it does
*here*.

- **`serde` — serialization for everything.** THE Rust answer to "turn my
  data into JSON and back": you annotate a struct with
  `#[derive(Serialize, Deserialize)]` and the compiler writes the code.
  Here it carries every seam in the system — save files, the multiplayer
  wire protocol, the JSON-only wasm boundary, the campaign artifacts, the
  serial messages to the physical board. Nine of the ten crates use it;
  the wire-protocol crate is little *but* serde types, on purpose.
- **`tokio` — the async runtime.** Rust ships async syntax but not a
  runtime; tokio is the de-facto one (the Node event loop, as a library
  you opt into). The room server uses it for the pattern this codebase
  loves: one task per campaign that owns the game and processes one
  command at a time — apply, persist to SQLite, then acknowledge.
- **`axum` — the web framework.** The current default HTTP framework,
  from the tokio team. Here it's deliberately boring: WebSocket endpoint
  in, room server behind it. Boring is the point — the interesting code
  is all in the engine.
- **Dioxus — React, in Rust.** A component/hooks UI framework that
  compiles to wasm. It powers the shipped web client (~10k lines of UI, a
  procedural audio engine included), the desktop shell via its webview
  renderer, *and* the new Campaign Studio — the graphical campaign editor
  — which is just another Dioxus app in the same workspace, reusing the
  campaign compiler crate directly. Honest note for this section: GUI is
  the youngest corner of the Rust ecosystem, and it shows; Dioxus is
  good and moving fast, but it is not 2015-React mature.
- **`wasm-bindgen` — the JS boundary.** The standard bridge for exposing
  Rust to JavaScript. This repo's embedding crate keeps the boundary
  radical: one stateful handle, nothing but JSON strings across the seam
  — a ~260-line crate any JS host can drive.

**A brief aside — web app vs. native app, and how Dioxus handles both
(3 min).** Worth its own beat, because "we shipped the desktop app for the
cost of a shell" sounds like marketing until you see the mechanics:

- **The web app** is the UI crate compiled to wasm; Dioxus renders the
  components into the browser's own page structure. Nothing is installed;
  the browser is the runtime.
- **The native app** is the *same UI crate* — same components, same state
  hooks, unchanged — with Dioxus's desktop renderer instead: it opens a
  native window and renders into the operating system's built-in webview
  (the browser engine every OS already ships). Not the Electron model — no
  bundled browser, so the binary stays small; the trade is that you link
  the system's GUI libraries, which is exactly why the desktop shell is
  the crate quarantined outside the workspace.
- **The switch is a feature flag.** The web crate's `native-app` feature
  flips the shell, and the few genuinely-native concerns (window services,
  file locations) are injected behind a small platform hook — the UI code
  never branches on "am I a desktop app?". Installers (`.deb`/`.dmg`/
  `.msi`) come from the Dioxus CLI's bundler, one command.
- **Honest asterisks:** the desktop build is single-player-only today (no
  multiplayer transport wired) and its audio is silent pending a native
  backend. One codebase does not mean every feature arrives everywhere
  simultaneously — it means the *rules* do.
- **`no_std` + `alloc` — the embedded story.** The core opts out of the
  standard library (no OS assumptions), keeping only heap allocation.
  That's not embedded-cosplay: it's what lets the identical engine crate
  serve the browser *and* the serial-line hardware controller, and CI
  builds that configuration on every commit.

## Part 4 — What Rust bought this project (6 min)

*Visual: two-column spread — "language features doing architectural work"
vs "the honest costs."*

The features that turned out to be load-bearing architecture, not syntax:

- **Closed enums + exhaustive matching.** The game's command set and
  effect set are enums — fixed lists of variants — and `match` must handle
  every variant or the build fails. Add a command, and the compiler hands
  you a to-do list of every place that must handle it. A missed case isn't
  a runtime surprise; it's a compile error.
- **Branded id types at zero cost.** A `RoomId` and a `CharacterId` are
  both just strings underneath, but the type system treats them as
  incompatible — passing one where the other belongs doesn't compile, and
  the wrapper vanishes at runtime. A whole bug family, deleted for free.
- **Traits as the extension idiom.** A trait is Rust's interface. Every
  extensible family in the engine — mechanics, doors, scenes, victory
  conditions, items, encounters — is one trait plus a lookup table plus a
  scripted fallback. Same idiom six times; the compiler enforces the
  contract each time.
- **Ownership as custody enforcement.** The engine's "no raw setters"
  rule — every state change goes through one guarded door — isn't a code
  review convention. Accessors are keyed by private types outside code
  cannot construct, and the ownership system makes that stick.

Then pay the toll onstage — the costs are real:

- **Compile times.** A ten-crate workspace with a wasm UI is not an
  instant build. Incremental builds are fine; clean builds cost minutes.
- **The learning curve.** The borrow checker — the compiler subsystem
  enforcing the memory rules — genuinely fights you for the first weeks.
  The fight is front-loaded and it does end, but it's real.
- **GUI ecosystem youth.** Dioxus is moving fast, which cuts both ways;
  and the desktop shell's system-library linkage (GTK/WebKit) caused
  enough pain that it's quarantined outside the workspace with a comment
  explaining itself.
- **Rust is a commitment.** Hiring, onboarding, and the ambient tooling
  assume you meant it. For this project — determinism, five targets, one
  codebase — it paid. A CRUD app would not collect these dividends.

## Part 5 — Getting started, and Q&A (3 min)

*Visual: three lines — `rustup`, `cargo new`, the Book.*

The on-ramp, for anyone sold: install `rustup`; `cargo new` something
small; read the official Book (it's genuinely good). Best first project:
port a small tool you already understand, so you're learning the language,
not the problem. And this repo is public — the root README is the
architecture document, and `cargo test --workspace` runs everything you
saw today.

**Q&A preparation:**

- **"How bad is async, really?"** The async ecosystem is the sharpest
  corner of the language. This repo's answer is representative: keep async
  at the edges (the server), keep the core synchronous and pure.
- **"How long until the borrow checker stops fighting me?"** Weeks, not
  months, for productive; the idioms become reflex. The fight is the
  compiler front-loading the debugging you'd otherwise do later.
- **"Can we hire for it?"** Fewer candidates, unusually high enthusiasm —
  Rust roles attract people who chose the language on purpose. Training a
  strong engineer into Rust is weeks; the Book plus one real project.
- **"When is Rust the wrong choice?"** When your problem is glue, CRUD, or
  a script — the ceremony buys you nothing there. Rust pays when
  correctness, portability, or performance is the product. This engine is
  all three; your admin dashboard is none.
- **"Why not Go / TypeScript / C++?"** The honest comparison: Go trades
  the type-system guarantees away for simplicity; TypeScript doesn't reach
  wasm-without-a-runtime or embedded; C++ reaches everywhere but without
  the safety proofs. This engine *was* TypeScript — it was rewritten into
  Rust against its own test corpus, and the TypeScript was deleted. That
  rewrite story is talk 04 in this folder.

## Timing checkpoints

- End of Part 1: ~4 min. Don't linger — the pitch earns nothing until the
  toolbox shows receipts.
- End of Part 2: ~13 min. Running long? Beats 4 (crates.io) and 9 (lints)
  compress to one sentence each; never cut beat 6 (the exclusion) or the
  `float_roundtrip` story in beat 7 — they're the memorable ones.
- End of Part 3: ~26 min with the web-vs-native aside. The aside is the
  talk's **flex cut** (−3 min): fold it back into one sentence on the
  Dioxus beat if the slot is tight. The crate map itself is the heart; if
  desperate, also fold `axum` into the `tokio` beat.
- End of Part 4: ~32 min. Never cut the costs column — it buys the whole
  talk its credibility.
- Part 5 lands at ~35 min, leaving 5 for Q&A in a 40-minute slot. With the
  flex cut you're back at ~32. For a strict 30: take the flex cut,
  compress Part 1 to one minute, and trim Part 3 to
  serde/tokio/Dioxus/no_std.
