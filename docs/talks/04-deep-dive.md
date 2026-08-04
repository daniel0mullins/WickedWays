# The Deep Dive (30–40 minutes)

**Title:** *One Engine to Rule Them All: determinism, closed vocabularies, and
golden pins as an architecture*

**Audience:** engineers who build long-lived systems — game devs, distributed
systems people, anyone who has watched domain logic fork across surfaces.
No Rust or game-dev background required — every term of art gets a
plain-English gloss at first use; every code moment is one screenful.
**Format:** 7 acts. Budget ~34 minutes of talk + 5 for questions. Each act
lists its visual, its script beats, and what to cut under time pressure.
Timing checkpoints at the end.

---

## Act I — The disease, and the bet (4 min)

*Visual: the fission diagram — "the rules" splitting into server / client /
tutorial / port boxes, each annotated with its failure: guesses undone,
stale fakes, divergent ports.*

Open with the disease everyone in the room has had. Any interactive system
that ships on more than one surface grows more than one implementation of its
own domain logic. In games it's vivid: the server owns the real rules. The
client re-implements a fast approximation so play feels instant — it
*predicts* each outcome, then has to undo and re-simulate whenever the server
disagrees; game developers call the guessing "prediction" and the undo
"rollback," and both are bug factories. The tutorial hardcodes a scripted
fake that goes stale. The board-game or console port is a rewrite that
diverges forever. Every copy is a place for the rules to disagree, and the
disagreement is where the worst bugs live — the ones that only reproduce on
one surface.

Wicked Ways — a turn-based horror RPG: a party of player characters and a
Game Master exploring a haunted house, room by room — is built on a bet:
**the rules exist in exactly one place, and every surface is a projection.**
The one place is `wickedways-core`, a ~24,000-line Rust crate (Rust's word
for a package). The projections, as shipped today:

- the browser client (the core compiled to WebAssembly — "wasm," the binary
  format browsers execute — and linked as an ordinary library, no bindings
  layer),
- a native desktop app (the same client code in a webview shell),
- a multiplayer room server (hosting the same engine, one per campaign),
- an embeddable wasm build for arbitrary JavaScript hosts (JSON in, JSON out),
- a **physical tabletop** — e-ink tiles, tap-to-identify NFC pieces — driven
  over a serial cable by, again, the same engine.

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
   mulberry32, a small, fast pseudo-random generator whose entire state fits
   in a few bytes. Every affliction shake-off roll (a d100 — a 1-to-100
   roll), every to-hit roll, every encounter roll, every map generation
   draws from it. And the generator's state rides *inside the save file*, so
   determinism survives save/load. One deliberate wrinkle proves the rule:
   at a physical table you can roll a *real* die and supply the result — but
   it enters the engine as a recorded command on the log, a literal value,
   so even physical dice keep replays exact. (More in Act VI.)
2. **No clock.** Wall-time access does not exist in the engine. There is
   nothing to mock because there is nothing there.
3. **No IO.** The engine is a pure state machine: commands in, state plus
   cues out — a "cue" being a presentation event ("play this sound," "show
   this narration") that carries no rules. Presentation subscribes to the cue
   stream; a crashing subscriber is isolated so it can't disrupt the turn
   loop.

Consequence one: **a game is a command log.** Same genesis — the world's
saved starting state — plus the same log, same world, on any machine, in any
decade. Save files are snapshots; replays are logs; bug reports are
reproducible by construction.

Consequence two — and this is the part distributed-systems folks will
recognize — **replication becomes trivial.** If resolution is deterministic
and centralized, replicas never need to resolve anything. Hold that thought
for Act V.

Consequence three: determinism has to survive *content*, not just engine
code. That's Act IV's problem: user-authored behaviors run inside the engine,
so the scripting surface itself must be deterministic — no loops, ordered
iteration, restricted arithmetic, randomness only via the injected generator.

War story beat (30 s, cuttable): determinism is fragile in dumb ways. Exit
ids are minted by *sorting the two room names* — and the historical
TypeScript engine sorted strings one way (by UTF-16 code units) while Rust
sorts them another (by UTF-8 bytes). In short: on plain ASCII text the two
orders agree exactly; on anything fancier — emoji, rare scripts — they'd
disagree. The committed goldens — the recorded known-good outputs CI
compares against, properly introduced in Act VII — were minted under the old
order, so room
names are constrained to ASCII, and the constraint is *documented as a
constraint* rather than silently patched. Determinism across a rewrite means
inheriting your past self's sorting quirks — write them down.

## Act III — The core: what "the rules in one place" buys you daily (5 min)

*Visual: the stat triangle (Health ← Sanity ← Energy ← Health), then the
mitigation formula on one line.*

Spend five minutes making the engine concrete, because "24k lines of rules"
is an abstraction. Three exhibits, chosen because each shows a *design
stance*, not just a feature:

**Exhibit 1 — the stat triangle.** Three stats, each guarded by the next in
a cycle: Sanity absorbs Health damage, Energy absorbs Sanity damage, Health
absorbs Energy damage. Every attack first rolls a d20 to-hit — a natural 20
is a critical hit for 1.5× damage, a natural 1 is a stumble where the
attacker hurts themselves, 2–5 misses outright — and then the damage that
lands runs the formula, which fits on a slide:

```
to-hit      = d20   (20: crit ×1.5 · 1: stumble · 2–5: miss · 6–19: hit)
mitigated   = max(0, attack − armor)
finalDamage = mitigated × max(0, 10 − mitigator) × 0.2 × lightMultiplier
```

A full guard stat (the "mitigator") absorbs everything; an empty one doubles
the damage. The `lightMultiplier` is a horror touch: light-averse monsters
take half again as much damage while their room is lit. Afflictions —
knock-out, Panic, Fear, Confused — trigger at stat thresholds, stick until
shaken off with escalating per-turn recovery rolls, and *restrict which
actions you may even attempt*. The stance: mechanics interlock through
shared state, which is exactly why they must not be re-implemented per
surface — you'd be forking a system, not a function.

**Exhibit 2 — lifecycle guards as API contract.** Illegal operations —
acting before `begin_campaign`, the Game Master leaving mid-game, acting
past your per-turn action budget (each character gets a few actions per
turn), equipping past slot capacity — throw `ProceduralViolation`. The
engine doesn't return best-effort results for illegal states; it refuses
them, and the refusal strings are themselves replay-observable and pinned by
the goldens. The stance: the type system (branded id types — a `RoomId`
cannot be passed where a `CharacterId` goes, at zero runtime cost) and
runtime guards are the same idea at two layers: make illegal states
unrepresentable, or at least unexecutable.

**Exhibit 3 — hidden state with one custodian each.** Ownership, durability,
equip state, the material pool, codex recording — all written only through
accessors keyed by private types that outside code cannot construct. The key
to the setter literally cannot be minted anywhere else, so the accessor is
the only door — "unforgeable" is earned, not asserted. No stray subsystem
can re-point an item's owner or refill durability. The stance: "one place"
isn't just one crate; within the crate, each invariant has one custodian.

And the portability stance: the core compiles without assuming an operating
system underneath (Rust's `no_std` mode), and CI builds it that way on every
commit. That's not ideology — it's what lets the identical crate compile to
wasm for the browser and native for a serial-port controller (Act VI).

## Act IV — Discipline #2: closed vocabularies, or how content can't break the engine (7 min)

*Visual: the extension stack — trait → native lookup → scripted fallback —
and the eight-variant effect set as a literal closed list.*

Now the extension system, because "one engine" dies the day someone needs a
doom counter and patches the core to get it.

**One idiom, six families.** Every extensible family — mechanics, exits,
scenes, victory conditions, items, encounter formations — follows the same
pattern: a trait (Rust's version of an interface — `MechanicOp`,
`ExitBehavior`, …), a built-in lookup table from name to compiled-in
implementation, and a fallback to **scripted behaviors** resolved from the
campaign catalog — the compiled registry of behavior scripts, items, and
recipes that ships with a campaign. Native-first resolution; an unknown name
is a `ProceduralViolation` at load, not a surprise at hour three of a
session.

**The scripts are data, not a language runtime.** Campaign content is
authored in TOML — a plain-text configuration format; behavior bodies are
written in a small domain-specific language (a "DSL" — a mini-language built
for one job):

```toml
[behaviors.mechanic.dread]
init = {}
onTurnStart = '''
  guard !hasEquipped(actor, 'lantern')
  emit adjustStat(actor, sanity, -1)
'''
modifyDamage = "damage.amount > 3 ? final 3 : damage.amount"
```

(That `final` keyword locks the damage value and skips any remaining
damage-adjusting hooks — more on the chain below.) The DSL parses into a
closed, **loop-free** abstract syntax tree (an "AST" — the program stored as
a plain data structure the Rust core walks). No user code executes; a data
structure is evaluated. Iteration is ordered; float arithmetic is restricted
to the four operations and comparisons; number-to-string formatting is
pinned byte-for-byte; randomness only via the injected generator.
Determinism survives content because the content *can't express*
nondeterminism.

**Effects: the closed output vocabulary.** Hooks come in two shapes:
*reducers*, which react to events (turn start, round end) and return a list
of requested effects; and one *transformer*, which adjusts an in-flight
damage value before it lands. Neither mutates anything directly — effects
come from a closed set — damage, heal, adjustStat, grantImmunity, cue,
status, giveItem, setVisible — and the engine applies each one itself,
clamped to legal ranges, through the private-key accessors from Act III.
Walk the four guardrails (the letters are their fixed names; the walk is by
priority, which is why D comes before C):

- **A, Integrity:** the closed effect set plus clamped application; no raw
  setters reachable, ever.
- **B, Determinism:** hooks receive a read-only view of the world — no
  engine handles, no clock, no IO — plus the injected `rng()`/`roll(n)`.
- **D, Termination:** *collect-then-apply* — all reducers run against the
  pre-event state, then the collected effects apply in one deterministic
  pass, so no reducer observes another mid-event; a hard cap of 64 effects
  per mechanic per event; and no re-entry (applying effects doesn't trigger
  more hooks).
- **C, Balance** — limits on how mechanically powerful an effect content may
  produce: advisory. Label it honestly and get the laugh: three guardrails
  are walls, one is a sign.

**Scope discipline is part of the vocabulary.** The v1 effect set
deliberately *excludes* spawning monsters, ending the campaign, forging
ownership, destroying items. Reducers can't cancel each other's effects.
Only the damage-transformer chain can stop early — that `final` keyword from
the code sample — and when several mechanics transform the same damage, they
run in the order the campaign opted them in, fixed at authoring time:
precedence is data, not a race. Each exclusion is written down with its
revisit condition. The stance to sell: **a closed vocabulary is only closed
if you can say no** — every "just this once" escape hatch is a second rules
implementation wearing a trench coat.

**Proof of expressiveness** — the objection to closed vocabularies is always
"you can't write real content in that." Receipt: the entire shipped campaign,
Hollow House — 9 rooms, 13 exits, 3 keyed doors, an NPC dialogue tree with a
give-the-key hand-off that fires exactly once, 3 mechanics including a
narration-driving storyteller and the damage-capping dread above, 3 victory
conditions — is authored in **one TOML file** whose compilation reproduces
the committed description + catalog JSON byte-for-byte. The DSL isn't a
demo; it's the production authoring surface.

**What the discipline buys: the DOOM ambition (1 min, first flex cut).**
Say the goal out loud: id Software's DOOM — the 1993 shooter — is the
high-water mark of mod-friendliness. Its engine was strictly separated from
its content, and thirty-plus years later strangers are *still* shipping new
levels for it; the game outlived its own hardware because the community
could keep feeding it. Wicked Ways is explicitly chasing that property for
tabletop horror, and everything in this act is the strategy, not a cage:

- **First-party content has no privileges.** Hollow House is, structurally,
  a mod — the shipped campaign uses the exact TOML surface a modder would.
  (DOOM shipped as data files its own engine loaded; same move.)
- **A bad mod is boring, not catastrophic.** An unknown behavior name fails
  at load, effects are clamped to legal ranges, the 64-per-event cap holds,
  and there is no path to raw state — the worst a hostile campaign file can
  do is be dull. It cannot corrupt a save.
- **Mods outlive engine versions.** A save stores `{ key, state }` and
  re-binds behavior on load, and the goldens pin engine behavior — so a
  campaign authored against this year's engine behaves identically on next
  year's unless a change was made deliberately, with a reviewed diff.
- **One mod, every surface.** Author a campaign once and it runs in the
  browser, on desktop, on the multiplayer server, and on the physical board
  — the modder does nothing.
- **Modded games keep the guarantees.** Determinism doesn't exempt mods:
  replays, saves, and reproducible bug reports work for community content
  exactly as for ours. And the compiler is the declared trust boundary —
  malformed author input produces an error, never a crash.

Honest gap, stated plainly: mod-friendly also means *shareable*, and the
packaging story — hand someone a compiled campaign file and load it at
runtime — is still open work. The rails are built; the loading dock isn't.

## Act V — Discipline #3 applied: sync, or multiplayer as a solved problem (6 min)

*Visual: the submit pipeline — `submit → authorize → apply → Delta diff →
ordered log` — with replicas hanging off the log.*

This is the payoff act. Multiplayer in most games is its own discipline:
prediction, rollback, reconciliation, cheat handling. Here it's a command
log with a single resolver, and it falls out of Acts II–IV almost
mechanically.

**The shape.** Clients own a `SyncCoordinator` holding a local replica — the
client's copy of the world. On `submit`, the coordinator passes the command
to the **Authority** — the one engine — which authorizes it, applies it,
computes a **Delta** (a minimal patch describing what changed), appends
`{ seq, delta }` to an ordered log, and returns it. The coordinator applies
the delta and hands back the result. Three "no"s do the heavy lifting:

- **No optimistic mutation.** State changes only when an authoritative delta
  arrives. No rollback exists because nothing is ever ahead of the log.
- **No replica-side logic.** The `DeltaApplier` patches state and *never
  draws randomness or runs game rules*. Convergence isn't tested into
  existence; it's true by construction. Gaps heal by requesting the missing
  log entries; a late joiner loads a recent snapshot, then replays the
  deltas after it.
- **No ambiguity between "denied" and "did nothing."** A rejection (wrong
  turn, a command from someone else's seat — a "seat" being a player's
  claimed character slot — or a `ProceduralViolation`) never commits. A *fizzle* — a
  legal action with no mechanical effect, like a fully-absorbed attack —
  commits, produces a delta, and propagates. The distinction is part of the
  wire contract, and it matters: replicas must agree on history, including
  the boring parts.

**One authority, every topology.** Here's the "one engine" thesis paying
compound interest:

- *Single-player, in the browser:* the same Authority behind an in-process
  connection, with `AuthorityOpts.solo` on — the engine itself drives the
  full per-turn machinery: budgeted turns, affliction ticks, monster
  reactions, round advance.
- *Multiplayer:* the same Authority hosted per campaign by the room server
  (built on axum, a Rust web framework), each behind a single task that owns
  the state and handles one submit at a time — apply, persist to SQLite, and
  only then acknowledge. Players hold seats — you can only act for the
  character slot you claimed — and `AuthorityOpts.manage_turns` is on, so a
  seat whose per-turn action budget is spent is refused at submit.

Single-player versus multiplayer is **two boolean options and a transport
choice**. There is no multiplayer fork of the rules to keep in sync, because
there is nothing to fork. And the seams stay honest: the golden check for
this layer constructs the authority with both flags *off*, so the
authorization core stays byte-stable against its recorded outputs — the two
options are layered *around* the pinned core, not threaded through it.

Cuttable nuance (30 s): even client-side conveniences are disciplined. Keyed
doors are gated in the UI via a pure ask-the-engine query
(`exit_block_reason`) — the surface narrates the locked-door message and
*issues no command* — rather than letting surfaces re-derive rules. The one
place surfaces touch rules, it's a read-only question put to the engine.

## Act VI — The faces: pricing a new surface in lines of code (6 min)

*Visual: the five surfaces around the core, each annotated with its size:
web ~10k (all presentation), wasm boundary ~260, tabletop bridge ~1.4k,
controller ~400, desktop shell ~a few hundred.*

Walk the surfaces as *receipts*, cheapest story last:

**Browser** (`wickedways-web`, ~10k lines): the shipped product, built with
Dioxus — a React-like UI framework for Rust — compiled to wasm, linking the
core as an ordinary library. All ten thousand lines are presentation — a
retro terminal-style interface where you type commands, point-and-click
affordances, a procedural audio engine (four sound-effect categories plus an
ambient drone that tracks the party's sanity) built entirely off the
engine's cue stream. Presentation is a *subscriber*: each cue arrives with
its sound already chosen by the engine, so the audio layer just plays it;
and the room-reveal cue drives what the renderer shows while the underlying
data stays intact.

**Desktop** (`desktop/`): the same client crate behind a compile-time flag,
wrapped in a webview shell. Deliberately kept out of the main build so its
Linux GUI system libraries never have to be installed to build or test
anything else — a boundary defended in the build system, not just in review.
Ships `.deb`/`.rpm`/AppImage/`.dmg`/`.msi` via `dx bundle`.

**JS embedding** (`wickedways-wasm`, ~260 lines): a stateful `Authority`
handle for any external JavaScript host. **Nothing but JSON strings crosses
the boundary** — a command in; cues, a view of the world, a snapshot out. No
host ever holds a live engine object; undo is host-side snapshot/restore. A
closed vocabulary at its most literal.

**The physical tabletop** (`wickedways-tabletop` ~1.4k lines +
`wickedways-controller` ~400): the headline receipt. The bridge turns the
engine's `ViewModel` — its ready-to-render description of what each player
can see — plus the party roster and the fog-of-war map (unexplored areas
hidden) into device commands: paint e-ink tiles, place pieces, update the
players' little status displays. Inbound device events — an NFC piece set
down on a tile, physical dice read off the table — resolve into
character-tagged engine commands. The dice are the poetic part: roll a real
d20 for your attack and the value reaches the engine as a recorded
`SupplyDice` command, consumed by the same one seam all randomness flows
through — so a physical die becomes engine randomness *without breaking
replay*, because the rolled value rides the command log. Skip the roll and
the house's seeded generator rolls for you. A codec
frames the JSON messages for the serial line using COBS — a standard
byte-stuffing trick that marks packet boundaries on a raw byte stream. Three
design points:

- The bridge depends only on the core plus serde (Rust's standard
  serialization library), so it compiles **native** for the controller *and*
  **to wasm** — the web client renders an on-screen simulator of the
  physical board through the *same bridge code*.
- The `DeviceTransport` interface is the only thing that differs between the
  simulator and real firmware.
- The controller's `--dry-run` exercises the full engine→bridge→codec path
  with no hardware attached — the physical product is testable in CI like
  everything else.

Land the point: a *physical board game* was added to a video game for the
price of a protocol adapter, and the rules never knew. That is the "one
engine" bet, paid out.

**Coda — blue sky (45 s, second flex cut).** The qualifying test for a
surface is now visible: *can it render a view of the world and submit
commands?* Anything that passes is a bridge away, because the game is
turn-based (latency-tolerant), the authority does all the thinking, and the
seams are plain JSON. So, without committing to any of them:

- **VR/AR.** The haunted house *around* you — or augmented reality laid
  over the real tabletop, ghost effects rising off the physical tiles. The
  bridge already separates "what to show" from "how to show it"; a headset
  is a very fancy renderer of the same view model.
- **A voice surface.** It's a turn-based game whose canonical interface is
  typed commands — a smart speaker is that parser with ears. "You hear
  something scratching at the cellar door" was practically written for it.
- **A chat-platform seat.** A Discord or Slack bot holding a seat: commands
  in, narration out. The room server already speaks WebSocket; a bot is
  just a client without pixels.
- **Spectator streams.** Replicas are cheap — the delta applier never runs
  rules — so a spectator view is a replica with no seat, and a stream
  overlay is a renderer over it.

None of these would touch `wickedways-core`. The engine doesn't know what a
screen is — and that ignorance is the entire feature.

## Act VII — Golden pinning, the rewrite, and what it all costs (4 min)

*Visual: `conformance/fixtures/` — 256 files; the four gates; then the
timeline: TS engine → goldens → Rust engine matches byte-for-byte → TS
deleted.*

The third discipline is what makes the first two *stay* true.

**The corpus.** 256 committed fixtures pin observable behavior end to end —
"goldens": recorded known-good outputs the tests must reproduce exactly —
via four gates under plain `cargo test`: the **author** gate (TOML →
description + catalog), the **assembler** gate (artifacts + seats → genesis —
deliberately gated only on *pre-begin* snapshots, so assembler correctness
never conflates with engine correctness), the **replay** gate (every
committed gameplay recording stepped command-by-command, diffing result +
snapshot + view per step), and the **sync** gate (command logs →
`{ seq, delta }` streams, byte-for-byte).

**The workflow is the point.** Goldens are regression pins of the engine's
own output. An intended behavior change means `UPDATE_GOLDENS=1`, then
**review the behavioral diff like code**, then commit it alongside the
change. Regeneration is deterministic — a second run must produce a zero git
diff. Never hand-edit a golden. Serialization is behavior: even a one-line
change to how a field serializes shows up as a golden diff and gets reviewed
as one.

**The receipt of receipts.** The engine began life in TypeScript. The corpus
was strong enough to serve as the oracle — the source of every expected
answer — for a complete rewrite in Rust: build until the goldens match
byte-for-byte, then delete the TypeScript tree. Your test suite has reached
escape velocity when it can carry the system across a *language*.

**What it costs** — close honest, one minute:

- Determinism taxes every feature: no ambient randomness, no clock, generator
  threading, replay tests. Paid daily.
- Closed vocabularies tax expressiveness: real features wait for the
  vocabulary to grow deliberately (the v1 exclusion list is long, and
  enforced). Saying no is a job.
- Golden pinning taxes velocity: every observable change produces a diff
  someone must actually read. And room names are ASCII-only forever, because
  the old TypeScript engine's sort order is baked into the fixtures (the
  Act II war story — if you cut that story, cut this line too).

What it buys: no rules disagreement between surfaces, ever, because there is
exactly one implementation to disagree with itself. Multiplayer without a
dedicated networking ("netcode") team. Ports priced in bridge-lines.
Rewrites that are merely *work*, not *risk*.

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
  no rules to tamper with. Seat checks gate who may act for whom. The
  remaining surface is information leakage (replicas hold full state) —
  hiding unexplored areas is presentation-side today; per-seat view
  filtering is future work, and the delta pipeline is where it would go.
- **"Is the scripting language Turing-complete?"** Deliberately not —
  loop-free, closed syntax tree. Termination is a grammar property, not a
  runtime watchdog (plus the 64-effect cap per event).
- **"How do goldens not ossify the engine?"** Regeneration is a first-class,
  deliberate workflow with reviewed diffs — the pins move; they just can't
  move *silently*. The assembler-gate scoping shows the corpus is curated,
  not hoarded.
- **"Why Rust specifically?"** The properties that matter: one codebase
  compiling to wasm, native, and OS-free embedded targets; exhaustive
  pattern-matching over the closed command/effect sets, so a missed case is
  a compile error; and zero-cost branded id types. The architecture would
  survive in another language; it would just be enforced by convention
  instead of the compiler.
- **"What's not unified?"** Chat and audio/video: the network protocol
  reserves message types for them, but the Rust server doesn't implement
  them yet. The desktop shell is single-player-only today. And Balance is
  advisory. Knowing where the line is beats pretending there isn't one.

## Timing checkpoints

- End of Act II: ~9 min. Long? Cut the exit-id war story (−30 s) — and with
  it, the ASCII line in Act VII's cost list.
- End of Act IV: ~21 min with the DOOM beat. It is the **first flex cut**
  (−60 s): dropping it loses the ambition framing but no argument. Also
  cuttable: compress Act III's exhibits to one each (triangle + custodians),
  −90 s.
- End of Act V: ~27 min. Act V is the thesis's proof — never cut it.
- End of Act VI: ~33 min with the blue-sky coda — the **second flex cut**
  (−45 s). The tabletop is the emotional peak; if desperate, compress
  browser/desktop/embedding to their size-tally sentence.
- Act VII lands at ~36 min, leaving ~4 for questions in a 40-minute slot.
  With both flex beats cut you're back at ~34. For a strict 30, drop both
  flex beats and the war story, halve Act III, and compress the Q&A buffer.
