# The Rust Ecosystem Tour (30–40 minutes)

**Title:** *One Engine, Written in Rust: a working tour of the Rust
ecosystem*

**Audience:** engineers curious about — or evaluating — Rust. No Rust
experience assumed; familiarity with some package ecosystem (npm, pip) is
leaned on for analogies. Unlike talks 01–04, this one is *about* the Rust,
using Wicked Ways as the case study — every ecosystem concept is shown
doing a real job in a shipped codebase, never taught abstractly.
**Format:** 6 parts, ≈38–41 minutes of talk (≈35 with both flex cuts taken)
+ Q&A. Speaker notes are the
script; timing checkpoints and cut order at the end.

---

## Part 1 — Why Rust exists (3 min)

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
   the compiler up front instead of the debugger at 2 a.m. (Part 5 shows
   this doing *architectural* work, not just catching typos.)
3. **One language, an absurd range.** The same source compiles natively for
   your OS, to WebAssembly for the browser, and for bare-metal targets with
   no operating system at all.

## Part 2 — The language in five ideas (6 min)

*Visual: two slides — a dozen lines of real Rust, annotated; then the five
ideas as labeled rows.*

Before the ecosystem, meet the language — once, concretely. Put real code
on screen and read it aloud; this is adapted from the engine's effect
system:

```rust
// A fixed menu of outcomes — each variant carries its own data.
enum Effect {
    Damage { target: CharacterId, amount: u32 },
    Heal   { target: CharacterId, amount: u32 },
    Cue(String),
}

// `&` means "borrow it to look at it" — no copy, no handover.
fn describe(effect: &Effect, world: &World) -> String {
    match effect {
        Effect::Damage { target, amount } =>
            format!("{} takes {amount}", world.name(target)),
        Effect::Heal { target, amount } =>
            format!("{} recovers {amount}", world.name(target)),
        Effect::Cue(line) => line.clone(),
    }
}
```

Then walk the five ideas — this is the whole language orientation, and
everything later in the talk hangs off it:

1. **Ownership & borrowing.** Every value in Rust has exactly one owner.
   Everyone else *borrows* it — that's the `&` in the code above — and the
   compiler checks every borrow at build time: nothing is used after it's
   gone, and there are never two writers at once. This is the mechanism
   behind Part 1's headline: memory safety from rules checked at compile
   time, not from a garbage collector at runtime.
2. **Enums that carry data.** An enum is a fixed menu of variants — and
   unlike the numbered constants of C or Java, each variant carries its own
   payload: `Damage` holds a target and an amount; `Cue` holds a line of
   text. Most Rust designs start exactly here — model the possibilities as
   a closed list.
3. **Exhaustive `match`.** `match` is switch, grown up: it unpacks the
   variant's data, and it must cover *every* variant or the program doesn't
   compile. Add a variant next month, and the compiler hands you a to-do
   list of every place that must now handle it.
4. **Traits — and `#[derive]`.** A trait is Rust's interface: a contract a
   type can implement. The everyday superpower is `#[derive(...)]`: one
   annotation above a type asks a library to implement its trait for you,
   generated at compile time. Hold that thought for serde in Part 4.
5. **No null, no exceptions.** Absence is `Option` (a value, or nothing);
   failure is `Result` (a value, or an error). Both are ordinary enums —
   which means `match` forces you to handle the empty and error cases —
   and the `?` operator passes a failure up the call chain in one
   keystroke.

Land the forward-ties before moving on: **all five come back with jobs.**
Ownership becomes the engine's state-custody rule (Part 5). Enums plus
exhaustive match are the game's command and effect menus. `#[derive]` is
how serde carries every data seam. Traits are the engine's six-family
extension pattern. Nothing you just learned is a toy.

## Part 3 — The toolbox: the ecosystem in nine beats (12 min)

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
**An interlude — the ten crates, introduced (3 min).** The table is the
shape; here is the tour. Three groups, and one thing to notice as you go:
every dependency arrow points *inward*. Nothing the player touches is
depended on by anything else.

*The engine and the content pipeline:*

- **`wickedways-core`** (~26,600 lines) — the engine: world state, turn
  loop, combat, mechanics, sync. The only crate that knows the rules.
  Depends on `serde` and nothing else of consequence, and builds without
  an operating system underneath.
- **`wickedways-author`** (~4,300) — compiles a TOML campaign into the
  description + catalog pair. Its `Cargo.toml` carries a comment worth
  reading aloud: `rand` and `uuid` are *deliberately absent* — ids are
  derived from author-supplied names, never generated, and adding either
  crate "is a spec violation."
- **`wickedways-assemble`** (~1,800) — folds a seated party into those
  artifacts and emits the genesis snapshot. Same no-randomness rule: the
  same inputs produce byte-identical output, every time.

*Multiplayer and embedding:*

- **`wickedways-transport`** (245 lines) — the multiplayer wire protocol,
  and the smallest crate in the repo. It depends on `serde` *only* — not
  even on the engine. The protocol is a data contract, and the crate
  boundary proves it.
- **`wickedways-server`** (~1,900) — the room server: `axum` for the
  socket, `tokio` for one task per campaign, `rusqlite` for persistence
  with SQLite compiled in-tree so there's no system library to install.
- **`wickedways-wasm`** (260 lines) — the JavaScript embedding boundary:
  one stateful handle, nothing but JSON strings across the seam.

*The surfaces — where all the lines actually are:*

- **`wickedways-web`** (~10,800) — the shipped Dioxus client. Every line
  is presentation; its browser-API list reads like a tour of the platform
  (WebSocket, Web Audio, fullscreen, local storage).
- **`wickedways-studio`** (~7,400) — Campaign Studio, the graphical
  editor: another Dioxus app in the same workspace that reuses the author
  and assembler crates *directly* for its "Check campaign" button, and
  keeps campaigns in the browser's own database.
- **`wickedways-tabletop`** (~1,600) — the physical-board bridge. It
  depends on the core and `serde` and nothing else, which is exactly why
  it compiles both native for the hardware controller *and* to wasm for
  the on-screen simulator: one bridge, two worlds.
- **`wickedways-controller`** (423 lines) — the host binary that speaks
  to real hardware over a serial cable; its `--dry-run` exercises the
  whole path with no board attached.

And the eleventh, outside the workspace: **`desktop`** (162 lines) — the
native shell from the previous beat, and a good punchline for the group.
The exclusion isn't protecting something big; it's protecting everyone
else from 162 lines' worth of system GUI dependencies.

*And then show the graph.* The last slide of the interlude draws the whole
thing: the authoring pipeline feeding down into the core, the core spanning
the middle, the three boundary crates beneath it, and the four surfaces
reaching up through them. Two things to say over it. First, **every crate
on that slide depends on the core — except `wickedways-transport`**, which
depends on `serde` alone: the wire protocol doesn't know the game exists,
by design. Second, and better: **there are no arrows pointing *down* from
the core.** The engine has never heard of the browser, the board, or the
server. That's the architecture the other talks in this folder argue for —
and here it isn't a diagram in a wiki that drifts, it's the build.

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

## Part 4 — The ecosystem in the wild: the crate map (12 min)

*Visual: the hub diagram — the engine core in the center, each marquee
library annotated on the crate that uses it.*

Now the libraries everyone actually reaches for, each shown at its job
site. For each: what it is, why it's the ecosystem default, what it does
*here*.

- **`serde` — serialization for everything.** THE Rust answer to "turn my
  data into JSON and back": you annotate a struct with
  `#[derive(Serialize, Deserialize)]` — the derive trick from Part 2 —
  and the compiler writes the code.
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

## Part 5 — What Rust bought this project (5 min)

*Visual: two-column spread — "language features doing architectural work"
vs "the honest costs."*

Each of Part 2's five ideas, grown up into load-bearing architecture:

- **Closed enums + exhaustive matching.** The enum-plus-match you met in
  Part 2, at architectural scale: the game's command set and effect set
  are enums, and `match` must handle every variant or the build fails.
  Add a command, and the compiler hands you a to-do list of every place
  that must handle it. A missed case isn't a runtime surprise; it's a
  compile error.
- **Branded id types at zero cost.** A `RoomId` and a `CharacterId` are
  both just strings underneath, but the type system treats them as
  incompatible — passing one where the other belongs doesn't compile, and
  the wrapper vanishes at runtime. A whole bug family, deleted for free.
- **Traits as the extension idiom.** Every extensible family in the
  engine — mechanics, doors, scenes, victory conditions, items,
  encounters — is one trait plus a lookup table plus a scripted fallback.
  Same idiom six times; the compiler enforces the contract each time.
- **Ownership as custody enforcement.** The engine's "no raw setters"
  rule — every state change goes through one guarded door — isn't a code
  review convention. Accessors are keyed by private types outside code
  cannot construct, and the ownership system from Part 2 makes that
  stick.

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

## Part 6 — Getting started, and Q&A (3 min)

*Visual: three lines — `rustup`, `cargo new`, the Book.*

The on-ramp, for anyone sold: install `rustup`; `cargo new` something
small; read the official Book (it's genuinely good). Best first project:
port a small tool you already understand, so you're learning the language,
not the problem. And this repo is public — the root README is the
architecture document, and `cargo test --workspace` runs everything you
saw today. The closing slide leaves both links on screen:
<https://github.com/daniel0mullins/WickedWays> for the code, and
<https://hollow.wickedways.online> to play the shipped campaign in the
browser — that's the wasm build from Part 3, live.

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

- End of Part 1: ~3 min. Don't linger — the pitch earns nothing until the
  language and toolbox show receipts.
- End of Part 2: ~9 min. The code slide is **not** cuttable — an audience
  that never sees Rust never met it. If long, compress ideas 4–5 to one
  sentence each; the enum / match / borrow trio is the load-bearing half.
- End of Part 3: ~21 min. The crate interlude is the **first flex cut**
  (−3 min): sweep it by naming the three groups and going straight to the
  connection diagram, which is the beat that actually pays. Running long
  elsewhere? Beats 4 (crates.io) and 9 (lints)
  compress to one sentence each; never cut beat 6 (the exclusion) or the
  `float_roundtrip` story in beat 7 — they're the memorable ones.
- End of Part 4: ~33 min with the web-vs-native aside. The aside is the
  talk's **second flex cut** (−3 min): fold it back into one sentence on the
  Dioxus beat if the slot is tight. The crate map itself is the heart; if
  desperate, also fold `axum` into the `tokio` beat.
- End of Part 5: ~38 min. Never cut the costs column — it buys the whole
  talk its credibility.
- Part 6 lands at ~41 min. **Take both flex cuts for a 40-minute slot** —
  that puts you at ~35 with 5 for Q&A. For a strict 30: take both cuts,
  compress Part 1 to one minute, trim Part 2's ideas 4–5 to a sentence
  each, and trim Part 4 to serde/tokio/Dioxus/no_std.
