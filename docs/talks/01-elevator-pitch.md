# The Elevator Pitch (30–60 seconds)

> Use verbatim or trim to taste. The 30-second core is the first paragraph;
> the second paragraph upgrades it to 60 seconds when you have the time.

---

Wicked Ways is a turn-based horror RPG, but the interesting part is the
architecture: **the game rules exist in exactly one place** — a deterministic
Rust engine — and everything else is a projection of it. The browser client,
the native desktop app, the multiplayer server, and even a physical e-ink
board with NFC pieces all drive the *same* core through the *same* command
vocabulary. There is no client-side game logic anywhere: multiplayer clients
just apply authoritative deltas, so replicas converge byte-for-byte with no
rollback and no prediction bugs. Determinism is enforced — one seeded RNG, no
clock, no IO — which means every game is a replayable command log.

And we know the engine can't drift, because its behavior is pinned by a golden
corpus of 256 committed fixtures, replayed byte-for-byte in CI. That corpus is
strong enough that we rewrote the entire engine from TypeScript to Rust
against it, matched the goldens exactly, and deleted the TypeScript. Adding a
new surface costs a bridge, not a rewrite: the desktop app is a thin webview
shell, and the physical tabletop is a 1,400-line protocol adapter. One engine,
many faces — and the faces are cheap.

---

**If you get one follow-up question**, steer to whichever of these you can
answer fastest:

- *"How do mods not break determinism?"* → Closed effect vocabulary + a
  loop-free scripted DSL; extensions can't reach raw state or ambient
  randomness.
- *"How is single-player different from multiplayer?"* → It isn't. Same
  `Authority`, different transport (in-process vs WebSocket), two option
  flags.
- *"How do you dare refactor?"* → `UPDATE_GOLDENS=1`, review the behavioral
  diff like code, commit it. Regeneration is deterministic — a second run must
  produce a zero git diff.
