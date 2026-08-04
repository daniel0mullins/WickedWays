# Talks: One Engine to Rule Them All

A set of four talks, at four lengths, making the case for the Wicked Ways
architecture: **a single deterministic Rust engine as the only place game rules
exist, with every product surface — browser, desktop, multiplayer server, JS
embedding, physical tabletop — a thin projection of it.**

All four talks share one thesis and escalate in depth. Pick by venue:

| Talk | Length | Venue | Deck |
|---|---|---|---|
| [The elevator pitch](01-elevator-pitch.md) | 30–60 s | Hallway, intro slide, project one-liner | — (spoken) |
| [The lightning talk](02-lightning-talk.md) | 7–10 min | Meetup lightning slot, internal demo day | [pptx](decks/02-lightning-talk.pptx) |
| [The systems tour](03-systems-tour.md) | 10–15 min | Conference short slot, team onboarding | [pptx](decks/03-systems-tour.pptx) |
| [The deep dive](04-deep-dive.md) | 30–40 min | Full conference slot, architecture review | [pptx](decks/04-deep-dive.pptx) |

The decks in `decks/` are ready to present: 16:9, dark theme, with each talk's
script embedded as per-slide speaker notes. The talk documents remain the
canonical scripts — cut-order guidance, timing checkpoints, and Q&A prep live
there, not in the decks.

## The shared thesis

Most games that ship on N surfaces end up with N.x implementations of the
rules: the server has the real ones, the client has an optimistic
approximation, the tutorial has a scripted fake, and the board-game port is a
different product entirely. Wicked Ways refuses that split. The engine
(`wickedways-core`, ~24k lines, `no_std`-capable) is the **only** code that
knows the rules, and three disciplines make that hold at scale:

1. **Determinism as a load-bearing constraint** — one seeded RNG, no clock, no
   IO. Same genesis + same command log = same world, everywhere, forever.
2. **Closed vocabularies at every boundary** — a closed `Command` union in, a
   closed `Effect` union out, JSON-only seams. Extensions (native ops or the
   scripted DSL) speak the vocabulary; they never reach raw state.
3. **Golden pinning** — 256 committed fixtures and four byte-for-byte gates
   that pin the engine's observable behavior. Strong enough that the entire
   TypeScript engine was rewritten in Rust against them and then deleted.

The payoff: multiplayer with zero client-side game logic (replicas apply
deltas, never resolve rules), save/replay for free, and new surfaces that cost
a bridge, not a rewrite — the native desktop app is a ~thin shell crate, and
the physical e-ink tabletop is a 1.4k-line protocol adapter.

## Grounding

Every claim in these talks is checkable in the repo as of the commit that adds
them. Key reference points speakers should be able to pull up:

- `README.md` — the authoritative architecture document.
- `crates/wickedways-core/src/sync/` — Authority, Delta, coordinator.
- `crates/wickedways-tabletop/src/lib.rs` — the physical-board bridge header.
- `conformance/fixtures/` — the golden corpus and its README.
- `.github/workflows/checks.yml` — the gates in CI.
