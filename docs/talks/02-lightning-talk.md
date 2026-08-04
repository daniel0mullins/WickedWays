# The Lightning Talk (7–10 minutes)

**Title:** *One Engine to Rule Them All: five product surfaces, zero rule
duplication*

**Audience:** general engineers; no Rust or game-dev background assumed —
every term of art gets a plain-English gloss at first use.
**Format:** 8 slides, ~1 minute each, with a demo beat on slide 6 if a browser
is available. Speaker notes are the script; say them in your own words.

---

## Slide 1 — The problem everyone has (1 min)

*Visual: one box labeled "the rules," then it fissions into four boxes —
server, client, tutorial, port — each slightly different.*

Every multiplatform game ends up with more than one implementation of its own
rules. The server has the authoritative ones. The client re-implements a fast
approximation so the interface feels instant — it *guesses* each outcome,
then has to undo and re-simulate whenever the server disagrees. Game
developers call the guessing "prediction" and the undo "rollback," and both
are bug factories. The tutorial hardcodes a scripted fake that goes stale.
The board-game port is a separate product that diverges forever. Each copy is
a place for the rules to disagree — and they will.

Wicked Ways is a turn-based horror RPG — a party of characters exploring a
haunted house, one turn at a time — that refuses the split. This talk is
about what it takes to actually have **one** implementation, and what you get
paid for it.

## Slide 2 — The shape (1 min)

*Visual: `wickedways-core` in the center; spokes to browser (wasm), desktop
shell, multiplayer server, JS embedding, physical e-ink board.*

The core is a ~24,000-line Rust package (a "crate"): world state, turn loop,
combat, mechanics, sync. Around it, five surfaces:

- a **browser client** — the core compiled to WebAssembly ("wasm"), the
  binary format browsers run at near-native speed;
- a **native desktop app** — the same client code in a webview shell;
- a **multiplayer room server** — hosting the same engine, one per campaign;
- an **embeddable wasm build** for any JavaScript host — JSON strings in,
  JSON out;
- a **physical tabletop** — e-ink tiles and tap-to-identify NFC pieces,
  driven over a serial cable by the same engine.

None of these contain game logic. Every one drives the same core through the
same fixed menu of commands.

## Slide 3 — Discipline #1: determinism is load-bearing (1.5 min)

*Visual: `genesis + command log = world state`, stamped "everywhere, forever."*

Three rules, enforced, not aspirational:

1. All randomness flows through **one seeded random-number generator** owned
   by the world.
2. There is **no clock** — wall-time access doesn't exist in the engine.
3. There is **no IO** — the engine is a pure state machine over commands.

So the same genesis snapshot — the world's saved state at campaign start —
plus the same command log produces the same world, bit for bit, on any
machine. That single property is what makes everything on the next slides
*cheap* instead of heroic: replay, save/load, multiplayer convergence, and
regression testing all fall out of it.

## Slide 4 — Discipline #2: closed vocabularies (1.5 min)

*Visual: funnel in ("commands") and funnel out ("effects"), with a wall
labeled "no other door into the state" between extensions and state.*

Every boundary is a **closed vocabulary** — a fixed, enumerated list, with
nothing outside the list. Commands in: move, attack, take, talk, craft.
Effects out: campaign content and mods never change state directly — they
return *requests* from a fixed menu — deal damage, heal, adjust a stat, grant
immunity, emit a cue (a presentation event: "play this sound," "show this
line"), give an item, toggle visibility — and the engine applies each request
itself through its own guarded setters, clamping every value into legal
range. There is no other door into the state. Campaigns are authored in TOML
(a plain-text config format, like INI) and compiled into a small scripting
language with no loops, stored as a data structure the engine walks — data,
not executable code.

The consequence: user content can't corrupt state, can't introduce
nondeterminism, and can't become a second place where rules live. Illegal
transitions don't half-happen — the engine refuses them with an error it
calls a `ProceduralViolation`.

## Slide 5 — Discipline #3: golden pinning (1.5 min)

*Visual: `conformance/fixtures/` tree; "256 files, 4 gates, byte-for-byte."*

The engine's observable behavior is pinned by "goldens" — recorded known-good
outputs committed to the repo: compiled campaigns, starting-world snapshots,
full command-log replays, and multiplayer patch streams — 256 files, four CI
checks, compared byte-for-byte. Change behavior accidentally and CI fails.
Change it on purpose and you re-record deliberately, then **review the
behavioral diff like code**.

Proof this isn't theater: the engine began life in TypeScript. It was
rewritten in Rust against these goldens until the output matched
byte-for-byte — and then the TypeScript was deleted. The corpus was the
answer key for the whole rewrite. If your tests can carry you across a full
rewrite in a different language, they're pinning the right things.

## Slide 6 — What you get paid (1.5 min)

*Visual: three receipts — "multiplayer: no client logic," "desktop: a shell,"
"physical board: 1.4k-line bridge."*

**Multiplayer with no client-side game logic.** Clients submit commands; one
authoritative engine resolves them; every client applies the returned patches
("deltas") to its local copy — and the patch-applier never runs rules. No
guessing, no undoing, no divergence. Single-player is the *same* authority
behind an in-process connection, with a `solo` flag — not a separate mode of
the game.

**New surfaces are bridges, not rewrites.** The desktop app is a thin shell
around the web client, kept outside the main build so its OS-level
dependencies don't infect everything else. The physical tabletop — real
e-ink tiles, NFC pieces — is a ~1,400-line bridge that maps the engine's
ready-to-render view of the world onto device commands, and device events
back into engine commands. Even real dice work: roll a physical d20 for
your attack and the value enters the engine as a recorded command on the
log — so replays stay exact. The rules never knew a board was attached.

*(Demo beat, if live: play two browser tabs on one room server, or run the
controller — the little program that drives the physical board — in its
`--dry-run` mode.)*

## Slide 7 — What it costs (1 min)

*Visual: a toll booth.*

Honesty slide. The disciplines are constraints you feel daily:

- Determinism means no ambient anything — every feature routes randomness
  through the injected generator and gets replay-tested.
- Closed vocabularies mean saying "no" — the effect menu deliberately
  excludes spawning monsters, ending campaigns, forging items. Extensions
  wait for the vocabulary, not the other way around.
- Golden pinning means every behavior change produces a reviewable diff —
  slower than "just ship it," which is the point.

You pay in ceremony at the boundaries. You get paid in never debugging a
rules disagreement between surfaces — because there's nothing to disagree.

## Slide 8 — The takeaway (0.5–1 min)

*Visual: the slide-1 fission diagram, healed back into one box.*

If your domain logic will ever live on more than one surface, decide early
that it lives in exactly one place, and enforce it with three things:
**determinism, closed vocabularies, golden pins.** Everything else — the
multiplayer, the ports, the fearless rewrites — is downstream of that
decision.

One engine. Many faces. The faces are cheap.

---

### Timing checkpoints

- End of slide 3: ~4 min. Running long? Compress slide 4 to its consequence
  sentence.
- End of slide 6: ~7.5 min. The demo beat is the flex slot — cut it first.
- Slides 7–8 are 90 seconds of landing; never cut the cost slide, it buys
  credibility.
