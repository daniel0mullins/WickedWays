# Talks: One Engine to Rule Them All

A set of four talks, at four lengths, making the case for the Wicked Ways
architecture: **a single deterministic Rust engine as the only place game rules
exist, with every product surface — browser, desktop, multiplayer server, JS
embedding, physical tabletop — a thin projection of it** (a view/adapter over
the engine, holding no logic of its own).

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

The talks are written to be spoken to engineers with **no Rust, game-dev, or
project background**: every term of art gets a short plain-English gloss at
its first use in each talk. Keep that convention when editing them.

## The shared thesis

Most games that ship on several surfaces end up with more implementations of
the rules than surfaces — full copies plus partial approximations. The server
has the real rules; the client keeps a local guess at each outcome, corrected
whenever the server disagrees; the tutorial has a scripted fake; and the
board-game port is a different product entirely. Wicked Ways refuses that
split. The engine (`wickedways-core`, ~24k lines) is the **only** code that
knows the rules — and it builds without assuming an operating system
underneath (Rust's `no_std` mode), which is what lets the same code run in a
browser and on embedded hardware. Three disciplines make the split-refusal
hold at scale:

1. **Determinism as a load-bearing constraint** — one seeded random-number
   generator, no clock, no IO. Start from the same genesis snapshot (the
   world's saved state at campaign start), feed the same command log, and you
   get the same world, everywhere, forever. Even a physical die rolled at
   the table fits: its value enters the engine as a recorded command, so
   real dice don't break replays.
2. **Closed vocabularies at every boundary** — every interface is a fixed,
   enumerated list of message types: a closed set of commands in, a closed
   set of effects out, plain JSON at the seams (the places where two
   components meet). Extensions — compiled-in or written in the campaign
   scripting language — speak those vocabularies; they never touch raw state.
3. **Golden pinning** — "goldens" are recorded known-good outputs, committed
   to the repo, that every future run must reproduce byte-for-byte: 256 of
   them, enforced by four CI checks. Strong enough that the entire original
   TypeScript engine was rewritten in Rust against them and then deleted.

The payoff: multiplayer with zero client-side game logic (each client applies
authoritative patches — "deltas" — to its local copy instead of resolving
rules), save/replay for free, and new surfaces that cost a bridge, not a
rewrite — the native desktop app is a thin shell crate, and the physical
e-ink tabletop is a 1.4k-line protocol adapter.

## Grounding

Every claim in these talks is checkable in the repo as of the commit that adds
them. Key reference points speakers should be able to pull up:

- `README.md` — the authoritative architecture document.
- `crates/wickedways-core/src/sync/` — the multiplayer machinery (the
  Authority, Delta, and coordinator named in talks 3–4).
- `crates/wickedways-tabletop/src/lib.rs` — the physical-board bridge header.
- `conformance/fixtures/` — the golden corpus and its README.
- `.github/workflows/checks.yml` — the gates in CI.
