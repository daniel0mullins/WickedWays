# The Lightning Talk (7–10 minutes)

**Title:** *One Engine to Rule Them All: five product surfaces, zero rule
duplication*

**Audience:** general engineers; no Rust or game-dev background assumed.
**Format:** 8 slides, ~1 minute each, with a demo beat on slide 6 if a browser
is available. Speaker notes are the script; say them in your own words.

---

## Slide 1 — The problem everyone has (1 min)

*Visual: one box labeled "the rules," then it fissions into four boxes —
server, client, tutorial, port — each slightly different.*

Every multiplatform game ends up with more than one implementation of its own
rules. The server has the authoritative ones. The client re-implements a fast
approximation for responsiveness, and now there's rollback and prediction
drift. The tutorial hardcodes a scripted fake. The board-game port is a
separate product. Each copy is a place for the rules to disagree — and they
will.

Wicked Ways is a turn-based horror RPG that refuses the split. This talk is
about what it takes to actually have **one** implementation, and what you get
paid for it.

## Slide 2 — The shape (1 min)

*Visual: `wickedways-core` in the center; spokes to browser (wasm), desktop
shell, multiplayer server, JS embedding, physical e-ink board.*

The core is a ~24,000-line Rust crate: world state, turn loop, combat,
mechanics, sync. Around it, five surfaces:

- a **browser client** — the core compiled to wasm, linked directly;
- a **native desktop app** — the same client crate in a webview shell;
- a **multiplayer room server** — axum, hosting the same engine per campaign;
- an **embeddable wasm handle** for any JS host — JSON strings in, JSON out;
- a **physical tabletop** — e-ink tiles and NFC pieces, driven over a serial
  line by the same engine.

None of these contain game logic. All of them speak the same closed command
vocabulary to the same core.

## Slide 3 — Discipline #1: determinism is load-bearing (1.5 min)

*Visual: `genesis + command log = world state`, stamped "everywhere, forever."*

Three rules, enforced, not aspirational:

1. All randomness flows through **one seeded RNG** owned by the world.
2. There is **no clock** — wall-time access doesn't exist in the engine.
3. There is **no IO** — the engine is a pure state machine over commands.

So the same genesis snapshot plus the same command log produces the same world,
bit for bit, on any machine. That single property is what makes everything
else on the next slides *cheap* instead of heroic: replay, save/load,
multiplayer convergence, and regression testing all fall out of it.

## Slide 4 — Discipline #2: closed vocabularies (1.5 min)

*Visual: funnel in ("Command union") and funnel out ("Effect union"), with a
wall labeled "no raw setters" between extensions and state.*

Every boundary is a closed, serializable vocabulary. Commands in: a tagged
union — move, attack, take, talk, craft. Effects out: mods and scripted
content express *intent* through a closed effect set — damage, heal, adjust a
stat, grant immunity, emit a cue, give an item, toggle visibility — applied by
clamping appliers behind unforgeable seams. Campaign content is authored in
TOML and compiled to a loop-free, deterministic script AST the engine
interprets.

The consequence: user content and new features can't corrupt state, can't
introduce nondeterminism, and can't create a second place where rules live.
Illegal transitions don't half-happen — they throw a `ProceduralViolation`.

## Slide 5 — Discipline #3: golden pinning (1.5 min)

*Visual: `conformance/fixtures/` tree; "256 files, 4 gates, byte-for-byte."*

The engine's observable behavior is pinned by a committed golden corpus:
campaign compilations, genesis snapshots, full command-log replays, and sync
delta streams — 256 fixture files, four CI gates, compared byte-for-byte.
Change behavior accidentally and CI fails. Change it on purpose and you
regenerate deliberately, then **review the behavioral diff like code**.

Proof this isn't theater: the engine began life in TypeScript. It was
rewritten in Rust against these goldens until the output matched
byte-for-byte — and then the TypeScript was deleted. The corpus was the
migration oracle. If your tests can carry you across a full rewrite in a
different language, they're pinning the right things.

## Slide 6 — What you get paid (1.5 min)

*Visual: three receipts — "multiplayer: no client logic," "desktop: a shell,"
"physical board: 1.4k-line bridge."*

**Multiplayer with no client-side game logic.** Clients submit commands; an
authoritative engine resolves them; replicas apply the returned deltas — a
delta applier that patches state and never runs rules. No prediction, no
rollback, no convergence bugs. Single-player is the *same* authority behind an
in-process transport, with a `solo` flag — not a separate mode of the game.

**New surfaces are bridges, not rewrites.** The desktop app is a thin
workspace-excluded shell around the web client. The physical tabletop — real
e-ink tiles, NFC pieces — is a ~1,400-line crate that maps the engine's view
model to device commands and device events back to engine commands. The rules
never knew a board was attached.

*(Demo beat, if live: play two browser tabs on one room server, or run the
controller with `--dry-run`.)*

## Slide 7 — What it costs (1 min)

*Visual: a toll booth.*

Honesty slide. The disciplines are constraints you feel daily:

- Determinism means no ambient anything — every feature routes randomness
  through the injected RNG and gets replay-tested.
- Closed vocabularies mean saying "no" — the effect union deliberately
  excludes spawning mobs, ending campaigns, forging items. Extensions wait for
  the vocabulary, not the other way around.
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
