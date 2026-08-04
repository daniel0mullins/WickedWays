# The Deep Dive (30–40 minutes)

**Title:** *One Engine to Rule Them All: determinism, closed vocabularies, and
golden pins as an architecture*

**Audience:** engineers who build long-lived systems — game devs, distributed
systems people, anyone who has watched domain logic fork across surfaces.
Rust literacy helps but isn't required; every code moment is one screenful.
**Format:** 7 acts. Budget ~34 minutes of talk + 5 for questions. Each act
lists its visual, its script beats, and what to cut under time pressure.
Timing checkpoints at the end.

---

## Act I — The disease, and the bet (4 min)

*Visual: the fission diagram — "the rules" splitting into server / client /
tutorial / port boxes, each annotated with a real class of bug: prediction
drift, rollback glitches, tutorial lies, port divergence.*

Open with the disease everyone in the room has had. Any interactive system
that ships on more than one surface grows more than one implementation of its
own domain logic. In games it's vivid: the server owns the real rules, the
client re-implements a fast approximation and inherits rollback and
mis-prediction, the tutorial hardcodes a scripted fake that goes stale, and
the board-game or console port is a rewrite that diverges forever. Every copy
is a place for the rules to disagree, and the disagreement is where the worst
bugs live — the ones that only reproduce on one surface.

Wicked Ways — a turn-based tabletop horror RPG — is built on a bet: **the
rules exist in exactly one place, and every surface is a projection.** The
one place is `wickedways-core`, a ~24,000-line Rust crate. The projections,
as shipped today:

- the browser client (the core compiled to wasm, linked as a plain rlib),
- a native desktop app (the same client crate in a webview shell),
- a multiplayer room server (axum, hosting the same engine per campaign),
- an embeddable wasm handle for arbitrary JS hosts (JSON in, JSON out),
- a **physical tabletop** — e-ink tiles, NFC pieces — driven over a serial
  line by, again, the same engine.

The rest of the talk is the three disciplines that make the bet hold —
**determinism, closed vocabularies, golden pinning** — and an honest account
of what each one costs. Preview the receipts now so the audience knows where
we're going: multiplayer with zero client-side game logic; ports priced in
hundreds of lines; and a full TypeScript→Rust engine rewrite executed against
the test corpus, after which the TypeScript was deleted.

## Act II — Discipline #1: determinism is load-bearing (5 min)

*Visual: `genesis + command log = world`, then a column of the three enforced
rules.*

Determinism here is not a testing nicety; it is the foundation the other two
disciplines stand on. Three rules, mechanically enforced:

1. **One RNG.** All randomness flows through `World.rng` — a seeded
   mulberry32. Every d100 affliction shake-off roll, every encounter-table
   roll, every spanning-tree map generation draws from it. The RNG state
   rides *inside the snapshot*, so determinism survives save/load.
2. **No clock.** Wall-time access does not exist in the engine. There is
   nothing to mock because there is nothing there.
3. **No IO.** The engine is a pure state machine: commands in, state + cues
   out. Presentation subscribes to a cue stream; subscriber errors are
   isolated so a faulty renderer can't disrupt the turn loop.

Consequence one: **a game is a command log.** Same genesis, same log, same
world, on any machine, in any decade. Save files are snapshots; replays are
logs; bug reports are reproducible by construction.

Consequence two — and this is the part distributed-systems folks will
recognize — **replication becomes trivial.** If resolution is deterministic
and centralized, replicas never need to resolve anything. Hold that thought
for Act V.

Consequence three: determinism has to survive *content*, not just engine
code. That's Act IV's problem: user-authored behaviors run inside the engine,
so the scripting surface itself must be deterministic — no loops, ordered
iteration, restricted arithmetic, randomness only via the injected RNG.

War story beat (30 s, cuttable): determinism is fragile in dumb ways. Exit
ids are minted by *sorting the two room names* — and the historical
TypeScript engine sorted UTF-16 code units, which agrees with Rust's byte
order on ASCII and diverges above the basic multilingual plane. The committed
goldens were minted under the old order, so room names are constrained to
ASCII, and the constraint is *documented as a constraint* rather than
silently fixed. Determinism across a rewrite means inheriting your past
self's collation quirks — write them down.

## Act III — The core: what "the rules in one place" buys you daily (5 min)

*Visual: the stat triangle (Health ← Sanity ← Energy ← Health), then the
mitigation formula on one line.*

Spend five minutes making the engine concrete, because "24k lines of rules"
is an abstraction. Three exhibits, chosen because each shows a *design
stance*, not just a feature:

**Exhibit 1 — the stat triangle.** Three stats, each mitigated by the next in
a cycle: Health damage is mitigated by Sanity, Sanity by Energy, Energy by
Health. The formula fits on a slide:

```
mitigated   = max(0, attack − armor)
finalDamage = mitigated × max(0, 10 − mitigator) × 0.2 × lightMultiplier
```

A fully-rested mitigator absorbs everything; a depleted one doubles damage.
Afflictions latch off thresholds — KO, Panic, Fear, Confused — and *gate
which actions you may attempt*, with escalating per-turn shake-off rolls.
The stance: mechanics interlock through shared state, which is exactly why
they must not be re-implemented per surface — you'd be forking a system, not
a function.

**Exhibit 2 — lifecycle guards as API contract.** Illegal operations —
acting before `begin_campaign`, a GM leaving mid-game, equipping past slot
capacity — throw `ProceduralViolation`. The engine doesn't return best-effort
results for illegal states; it refuses them, and the refusal strings are
themselves replay-observable and pinned by the goldens. The stance: the type
system (branded id types — a `RoomId` cannot be passed where a `CharacterId`
goes, at zero runtime cost) and runtime guards are the same idea at two
layers: make illegal states unrepresentable, or at least unexecutable.

**Exhibit 3 — hidden state behind symbol seams.** Ownership, durability,
equip state, the material pool, codex recording — all written only through
symbol-keyed accessors (`HELD_BY`, `SET_DURABILITY`, `EQUIP`,
`DEPOSIT_MATERIALS`, `RECORD_ENCOUNTER`). External code — including
extensions — *cannot* re-point a holder or refill durability. The stance:
"one place" isn't just one crate; within the crate, each invariant has one
custodian.

And the portability stance: the core is `no_std`-capable, `alloc`-only
without the `std` feature, and CI gates that build. That's not ideology —
it's what lets the identical crate compile to wasm for the browser and native
for a serial-port controller (Act VI).

## Act IV — Discipline #2: closed vocabularies, or how content can't break the engine (6 min)

*Visual: the extension stack — trait → native registry → scripted fallback —
and the eight-variant Effect union as a literal closed set.*

Now the extension system, because "one engine" dies the day someone needs a
doom counter and patches the core to get it.

**One idiom, six families.** Every extensible family — mechanics, exits,
scenes, victory conditions, items, formations — follows the same pattern: a
trait (`MechanicOp`, `ExitBehavior`, …), a native `key → &'static dyn`
registry lookup, and a fallback to **scripted behaviors** resolved from the
campaign catalog. Native-first resolution; unknown keys are a
`ProceduralViolation` at load, not a surprise at hour three of a session.

**The scripts are a data-AST, not a language runtime.** Campaign content is
authored in TOML; behavior bodies are written in a small infix
expression/statement grammar —

```toml
[behaviors.mechanic.dread]
init = {}
onTurnStart = '''
  guard !hasEquipped(actor, 'lantern')
  emit adjustStat(actor, sanity, -1)
'''
modifyDamage = "damage.amount > 3 ? final 3 : damage.amount"
```

— that Pratt-parses into a closed, **loop-free**, deterministic AST the Rust
core interprets. No user code executes; a data structure is evaluated.
Iteration is ordered; float arithmetic is restricted to the four operations
and comparisons; number-to-string formatting is pinned byte-for-byte;
randomness only via the injected RNG. Determinism survives content because
the content *can't express* nondeterminism.

**Effects: the closed output vocabulary.** Hooks don't mutate; they return
effects from a closed union — damage, heal, adjustStat, grantImmunity, cue,
status, giveItem, setVisible — applied by clamping appliers through the
symbol seams from Act III. Walk the four guardrails, in priority order:

- **A, Integrity:** the closed union + clamped application; no raw setters
  reachable, ever.
- **B, Determinism:** hooks receive a read-only `CampaignView` projection —
  no engine handles, no clock, no IO — plus `rng()`/`roll(n)`.
- **D, Termination:** *collect-then-apply* — all reducers run against the
  pre-event state, then effects apply in one deterministic pass, so no
  reducer observes another mid-event; a hard `MAX_EFFECTS_PER_EVENT = 64`
  cap per mechanic per event; no re-entrancy (applying effects doesn't
  re-dispatch).
- **C, Balance:** advisory. Label it honestly and get the laugh: three
  guardrails are walls, one is a sign.

**Scope discipline is part of the vocabulary.** The v1 effect set
deliberately *excludes* spawning mobs, ending the campaign, forging
ownership, destroying items. Reducers can't short-circuit each other; only
the damage transformer chain has a `final` short-circuit, and precedence is
opt-in order, fixed at authoring. Each exclusion is written down with its
revisit condition. The stance to sell: **a closed vocabulary is only closed
if you can say no** — every "just this once" escape hatch is a second rules
implementation wearing a trench coat.

**Proof of expressiveness** — the objection to closed vocabularies is always
"you can't write real content in that." Receipt: the entire shipped campaign,
Hollow House — 9 rooms, 13 exits, 3 keyed doors, an NPC dialogue tree with a
once-latched key hand-off, 3 mechanics including a full storyteller and a
damage-capping dread, 3 victory conditions — is authored in **one TOML file**
whose compilation reproduces the committed description + catalog JSON
byte-for-byte. The DSL isn't a demo; it's the production authoring surface.

## Act V — Discipline #3 applied: sync, or multiplayer as a solved problem (6 min)

*Visual: the submit pipeline — `submit → authorize → apply → Delta diff →
ordered log` — with replicas hanging off the log.*

This is the payoff act. Multiplayer in most games is its own discipline:
prediction, rollback, reconciliation, cheat handling. Here it's a command log
with a single resolver, and it falls out of Acts II–IV almost mechanically.

**The shape.** Clients own a `SyncCoordinator` holding a local replica. On
`submit`, the coordinator passes the command to the **Authority** — the one
engine — which authorizes it, applies it, diffs a **Delta**, appends `{ seq,
delta }` to an ordered log, and returns it. The coordinator applies the delta
and hands back the result. Three "no"s do the heavy lifting:

- **No optimistic mutation.** State changes only when an authoritative delta
  arrives. No rollback exists because nothing is ever ahead of the log.
- **No replica-side logic.** The `DeltaApplier` patches state and *never
  draws RNG or runs game rules*. Convergence isn't tested into existence;
  it's true by construction. Gaps heal via `entriesSince`; late joiners
  hydrate from checkpoint + tail.
- **No ambiguity between "denied" and "did nothing."** A rejection (wrong
  turn, seat auth, a `ProceduralViolation`) never commits. A *fizzle* — a
  legal action with no mechanical effect, like a fully-mitigated attack —
  commits, produces a delta, and propagates. The distinction is part of the
  wire contract, and it matters: replicas must agree on history, including
  the boring parts.

**One authority, every topology.** Here's the "one engine" thesis paying
compound interest:

- *Single-player, in the browser:* the same Authority behind an
  `InProcessTransport`, with `AuthorityOpts.solo` on — the engine itself
  drives the full per-turn machinery: budget-driven turns, affliction ticks,
  light-tied mob reactions, round advance.
- *Multiplayer:* the same Authority hosted per campaign by the axum room
  server, behind a tokio actor that serializes submit → persist (SQLite) →
  ack, flush-before-ack, with seat-ownership auth — and
  `AuthorityOpts.manage_turns` on, so a seat with a spent budget is refused
  at submit.

Single-player versus multiplayer is **two boolean options and a transport
choice**. There is no multiplayer fork of the rules to keep in sync, because
there is nothing to fork. And the seams are honest: the sync gate constructs
the authority with both flags off, so the authorization layer stays
budget-free and byte-stable against its goldens — the option flags are
layered *around* the pinned core, not threaded through it.

Cuttable nuance (30 s): even client-side conveniences are disciplined. Keyed
doors are gated in the UI via a pure `exit_block_reason` query — the surface
narrates the locked-door message and *issues no command* — rather than
letting surfaces pre-resolve rules. The one place surfaces touch rules, it's
a read-only query exported by the engine.

## Act VI — The faces: pricing a new surface in lines of code (5 min)

*Visual: the five surfaces around the core, each annotated with its size:
web ~10k (all presentation), wasm boundary ~260, tabletop bridge ~1.4k,
controller ~400, desktop shell ~a few hundred.*

Walk the surfaces as *receipts*, cheapest story last:

**Browser** (`wickedways-web`, ~10k lines): the shipped product, a Dioxus app
compiled to wasm linking the core directly as a rlib. All ten thousand lines
are presentation — a CRT-style parser UI, point-and-click affordances, a
procedural audio engine (four SFX categories plus a sanity-reactive ambient
drone) built entirely off the engine's cue stream. Presentation is a
*subscriber*: cues carry pre-resolved sounds, the `visibility` cue drives
reveal/conceal in the renderer while the data model stays intact underneath.

**Desktop** (`desktop/`): the same client crate with a `native-app` feature,
wrapped in a dioxus-desktop webview shell. Deliberately workspace-*excluded*
so its GTK/WebKit linkage never contaminates the workspace gates — a boundary
defended in the build system, not just in review. Ships `.deb`/`.rpm`/
AppImage/`.dmg`/`.msi` via `dx bundle`.

**JS embedding** (`wickedways-wasm`, ~260 lines): a stateful `Authority`
handle for any external JS host. **Nothing but JSON strings crosses the
seam** — an intent in; `{ cues, mobAttacks?, error? }`, a view model, a
snapshot out. No host ever holds a live engine object; undo is host-side
snapshot/restore. A closed vocabulary at its most literal.

**The physical tabletop** (`wickedways-tabletop` ~1.4k lines +
`wickedways-controller` ~400): the headline receipt. The bridge turns the
engine's `ViewModel` + party roster + fog-of-war map into device commands —
paint e-ink tiles, place pieces, drive dashboards — and resolves inbound
device events (an NFC piece set on a tile) into actor-tagged engine commands.
A COBS-framed JSON codec speaks serial to real hardware. Three design points:

- The bridge depends only on core + serde, so it compiles **native** for the
  controller *and* **to wasm** — the web client renders an on-screen
  simulator of the physical board through the *same bridge code*.
- The `DeviceTransport` trait is the only thing that differs between
  simulator and firmware.
- The controller's `--dry-run` exercises the full engine→bridge→codec path
  with no hardware attached — the physical product is testable in CI like
  everything else.

Land the point: a *physical board game* was added to a video game for the
price of a protocol adapter, and the rules never knew. That is the "one
engine" bet, paid out.

## Act VII — Golden pinning, the rewrite, and what it all costs (4 min)

*Visual: `conformance/fixtures/` — 256 files; the four gates; then the
timeline: TS engine → goldens → Rust engine matches byte-for-byte → TS
deleted.*

The third discipline is what makes the first two *stay* true.

**The corpus.** 256 committed fixtures pin observable behavior end to end,
via four gates under plain `cargo test`: the **author** gate (TOML →
description + catalog), the **assembler** gate (artifacts + seats → genesis —
deliberately gated only on *pre-begin* snapshots, so assembler correctness
never conflates with engine correctness), the **replay** gate (every
committed recording stepped intent-by-intent, diffing result + snapshot +
view per step), and the **sync** gate (command logs → `{ seq, delta }`
streams, byte-for-byte).

**The workflow is the point.** Goldens are regression pins of the engine's
own output. An intended behavior change means `UPDATE_GOLDENS=1`, then
**review the behavioral diff like code**, then commit it alongside the
change. Regeneration is deterministic — a second run must produce a zero git
diff. Never hand-edit a golden. Serialization is behavior: a serde-attribute
change on a snapshot type shows up as a golden diff and gets reviewed as one.

**The receipt of receipts.** The engine began life in TypeScript. The corpus
was strong enough to serve as the oracle for a complete rewrite in Rust —
build until the goldens match byte-for-byte, then delete the TypeScript tree.
Your test suite has reached escape velocity when it can carry the system
across a *language*.

**What it costs** — close honest, one minute:

- Determinism taxes every feature: no ambient randomness, no clock, RNG
  threading, replay tests. Paid daily.
- Closed vocabularies tax expressiveness: real features wait for the
  vocabulary to grow deliberately (the v1 exclusion list is long, and
  enforced). Saying no is a job.
- Golden pinning taxes velocity: every observable change produces a diff
  someone must actually read. ASCII room names forever, because a dead
  engine's collation order is pinned in the fixtures.

What it buys: no rules disagreement between surfaces, ever, because there is
exactly one implementation to disagree with itself. Multiplayer without a
netcode team. Ports priced in bridge-lines. Rewrites that are merely *work*,
not *risk*.

Final slide: three decisions, compounding — **one deterministic core, closed
vocabularies at every boundary, goldens on everything observable.** Make them
early; they don't retrofit.

---

## Q&A preparation

Likely questions, with the honest answers:

- **"Doesn't a single authority add latency vs client prediction?"** Yes, a
  round trip. It's a *turn-based* game — the design spends latency tolerance
  to buy zero reconciliation. The pattern transfers to any turn-based or
  async domain; twitch games would need to re-open prediction.
- **"What about cheating?"** The authority resolves everything; clients hold
  no rules to tamper with. Seat-ownership auth gates who may act for whom.
  The remaining surface is information leakage (replicas hold full state) —
  fog-of-war is presentation-side today; per-seat view filtering is future
  work and the delta pipeline is where it would go.
- **"Is the scripting DSL Turing-complete?"** Deliberately not — loop-free,
  closed AST. Termination is a grammar property, not a runtime watchdog
  (plus the 64-effect cap per event).
- **"How do goldens not ossify the engine?"** Regeneration is a first-class,
  deliberate workflow with reviewed diffs — the pins move; they just can't
  move *silently*. The assembler-gate scoping shows the corpus is curated,
  not hoarded.
- **"Why Rust specifically?"** The properties that matter: one codebase
  compiling to wasm + native + `no_std`-adjacent targets, closed enums with
  exhaustive matching for command/effect unions, and branded types at zero
  cost. The architecture would survive in another language; it would just be
  enforced by convention instead of the compiler.
- **"What's not unified?"** Chat/A-V comms are reserved wire arms, not yet in
  the Rust server; the desktop shell is single-player-only today; Balance is
  advisory. Knowing where the line is beats pretending there isn't one.

## Timing checkpoints

- End of Act II: ~9 min. Long? Cut the exit-id war story (−30 s).
- End of Act IV: ~20 min. Long? Compress Act III's exhibits to one each
  (triangle + seams), −90 s.
- End of Act V: ~26 min. Act V is the thesis's proof — never cut it.
- End of Act VI: ~31 min. The tabletop is the emotional peak; if desperate,
  compress web/desktop/wasm to their size-tally sentence.
- Act VII lands at ~34–35 min, leaving 5 for questions in a 40-minute slot.
  For a strict 30, drop the war story, halve Act III, and compress the Q&A
  buffer.
