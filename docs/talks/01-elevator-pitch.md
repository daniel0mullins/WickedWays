# The Elevator Pitch (30–60 seconds)

> Use verbatim or trim to taste. The 30-second core is the first paragraph;
> the second paragraph upgrades it to 60 seconds when you have the time.

---

Wicked Ways is a turn-based horror RPG — a party of characters exploring a
haunted house, one turn at a time — but the interesting part is the
architecture: **the game rules exist in exactly one place**, a deterministic
Rust engine, and everything else is a thin view over it that holds no logic
of its own. The browser client, the native desktop app, the multiplayer
server, and even a physical e-ink board with tap-to-identify NFC pieces all
drive the *same* core through the *same* fixed set of commands. No client
contains game logic anywhere: a client sends a command, the one real engine
resolves it and sends back a patch, and every client applies that patch — so
every copy of the world stays byte-identical. Clients never guess an outcome
and later have to undo it, which means the whole class of multiplayer bugs
game developers call "prediction" and "rollback" simply can't exist.
Determinism is enforced — one seeded random-number generator, no clock, no
IO — so every game is a replayable log of commands.

And we know the engine can't drift, because its behavior is pinned by 256
committed "golden" files — recorded known-good outputs that CI replays and
compares byte-for-byte. That corpus is strong enough that we rewrote the
entire engine from TypeScript to Rust against it, matched the goldens
exactly, and deleted the TypeScript. Adding a new surface costs a bridge,
not a rewrite: the desktop app is a thin webview shell, and the physical
tabletop is a 1,400-line protocol adapter — real dice included: roll a
physical d20 and the value enters the engine as recorded input, so replays
still hold. One engine, many faces — and the faces are cheap.

---

**If you get one follow-up question**, steer to whichever of these you can
answer fastest:

- *"How does user content not break determinism?"* → Campaign scripts can
  only *request* outcomes from a fixed menu — deal damage, heal, give an
  item — written in a small scripting language with no loops and no access
  to the clock or hidden randomness. The engine applies each request itself,
  clamped to legal ranges; there's no other door into the state.
- *"How is single-player different from multiplayer?"* → It isn't. The same
  authority — the one object that owns the real engine — runs both; only the
  connection differs (in-process vs a WebSocket to the server), plus two
  option flags.
- *"How do you dare refactor?"* → Re-record the expected outputs with
  `UPDATE_GOLDENS=1`, review that behavioral diff like code, commit it.
  Regeneration is deterministic — a second run must produce a zero git diff.
