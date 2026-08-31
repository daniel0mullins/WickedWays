# Rust for JavaScript Developers (10 minutes)

**Title:** *You Already Know Half of This: Rust for JavaScript developers*

**Audience:** working JavaScript/TypeScript engineers. Assumes npm, `async`/
`await`, closures, and (for one slide) TypeScript discriminated unions. Assumes
no systems-programming background and no Rust at all.
**Format:** 10 slides after the title, ≈10 minutes. Every concept is shown as a
JS↔Rust pair — the JS on the left is code the audience could have written this
week; the Rust on the right does the same job. Speaker notes are the script.

The through-line: **most of Rust is already familiar; three ideas are genuinely
new.** Name the three (ownership, `Option`/`Result`, exhaustive `match`), spend
the talk on them, and let everything else ride on the analogy.

---

## Slide 1 — Why a JS dev should even look (1 min)

*Visual: three cards.*

- **You already ship to the same place.** Rust compiles to WebAssembly, so it
  runs in the browser next to your JS — this project's game engine is a Rust
  crate the web client links directly, and the same crate also runs on a server
  and on a microcontroller. One codebase, all three.
- **The types don't evaporate.** TypeScript's types are gone at runtime; they
  describe your intent to the editor. Rust's types survive to the machine code
  and the compiler refuses to build if you break them.
- **No garbage collector, no manual `free()`.** Rust works out when memory dies
  at compile time. That's the one genuinely alien idea, and it's slide 3.

Say plainly: this is a 10-minute tour, so it's an honest sketch, not a course.

## Slide 2 — The half you already know (1 min)

*Visual: a mapping table, JS on the left, Rust on the right.*

| You know | Rust calls it |
|---|---|
| `npm` / `yarn` | `cargo` — but it's also the test runner, doc generator and formatter runner |
| npm registry | crates.io; packages are called **crates** |
| `package.json` | `Cargo.toml` |
| `package-lock.json` | `Cargo.lock` — same idea, same reason |
| `nvm` / `.nvmrc` | `rustup` / `rust-toolchain.toml` (and it actually installs the version for you) |
| ESLint + Prettier | `clippy` + `rustfmt` — official, one config argument each, no bikeshedding |
| workspaces / monorepo | Cargo workspaces |
| `console.log(x)` | `println!("{x:?}")` |

The point to land: the *ergonomics* are familiar. `cargo new`, `cargo add`,
`cargo test`, `cargo run`. If you can drive npm, you can drive cargo on day one.
What's left to learn is the language — and mostly three ideas of it.

## Slide 3 — New idea #1: values have one owner (2 min)

*Visual: side-by-side — the same function call, and what each language lets you
know about it.*

```js
// JavaScript — everything is a reference, and the call tells you nothing
const party = ["Ada", "Bram"];
addMember(party);
console.log(party); // ["Ada","Bram","Cyrus"] — surprise, it mutated
```

```rust
// Rust — the call site has to admit it
let mut party = vec!["Ada", "Bram"];
add_member(&mut party);   // `&mut` is visible right here
println!("{party:?}");    // ["Ada","Bram","Cyrus"] — no surprise
```

Two rules do all the work:

1. **Every value has exactly one owner.** When the owner goes out of scope, the
   value is freed — that's the whole garbage collector, decided at compile time.
2. **Everyone else borrows**, either as a read-only `&` or a single exclusive
   `&mut` — and the compiler checks every borrow.

The second half of the idea, which trips up every newcomer once and then never
again:

```rust
let a = vec![1, 2, 3];
let b = a;              // `a` handed ownership to `b` — it *moved*
// println!("{a:?}");   // compile error: `a` doesn't own it any more
```

In JS both names would point at one array and you'd have aliasing bugs to find
at runtime. Rust makes you say which one owns it. **That is the borrow checker,
and that is the whole of the hard part.** Everything else on the next slides is
ordinary language design.

## Slide 4 — New idea #2: there is no `null` (1 min 15)

*Visual: side-by-side, the classic `find` bug.*

```js
// JavaScript — the bug is only a bug at 2 a.m.
const hit = party.find(p => p.name === "Ada");
hit.hp -= 3;   // TypeError: Cannot read properties of undefined
```

```rust
// Rust — `find` gives back an Option: "either a value, or nothing"
let hit = party.iter_mut().find(|p| p.name == "Ada");
if let Some(p) = hit {   // you cannot reach the value without handling "nothing"
    p.hp -= 3;
}
```

`Option<T>` is just an enum with two cases: `Some(value)` and `None`. There's no
`null` and no `undefined` in the language, so the "billion-dollar mistake" isn't
a discipline you maintain — it's a state you can't express. TypeScript's
`strictNullChecks` is chasing this; Rust started there.

## Slide 5 — …and no exceptions (1 min 15)

*Visual: side-by-side, parsing.*

```js
// JavaScript — which calls throw? Read the docs, or find out in prod.
try {
  const campaign = JSON.parse(text);
  return compile(campaign);
} catch (e) {
  return null;
}
```

```rust
// Rust — failure is in the return type, and `?` bubbles it up
fn load(text: &str) -> Result<Campaign, Error> {
    let campaign = serde_json::from_str(text)?;   // `?` = return the error early
    compile(campaign)
}
```

`Result<T, E>` is the other everyday enum: `Ok(value)` or `Err(problem)`. A
function that can fail says so in its signature — you can't be surprised by a
throw from three layers down. And `?` is the ergonomic bit: it's one character
that means "if this failed, stop and hand the error to my caller." It reads
about as lightly as `await`, and it's why Rust error handling doesn't feel like
Go's.

## Slide 6 — New idea #3: enums that carry data, and `match` (1 min 45)

*Visual: side-by-side — a TS discriminated union vs the real thing.*

TypeScript devs already write this shape. Rust makes it first-class and
enforced:

```ts
// TypeScript
type Effect =
  | { kind: "damage"; target: string; amount: number }
  | { kind: "heal";   target: string; amount: number }
  | { kind: "cue";    line: string };

switch (effect.kind) {
  case "damage": applyDamage(effect); break;
  case "heal":   applyHeal(effect);   break;
  // forgot "cue" — compiles fine, silently does nothing
}
```

```rust
// Rust — this is the actual effect type from this project's engine
enum Effect {
    Damage { target: String, amount: u32 },
    Heal   { target: String, amount: u32 },
    Cue(String),
}

match effect {
    Effect::Damage { target, amount } => apply_damage(target, amount),
    Effect::Heal   { target, amount } => apply_heal(target, amount),
    // forget Cue and the BUILD FAILS: "pattern `Cue(_)` not covered"
}
```

This is the slide TypeScript people lean forward at. `match` is **exhaustive**:
handle every case or it doesn't compile. Add a fourth effect a year later and
the compiler hands you a to-do list of every place that has to deal with it —
across the whole codebase, before you run anything. In this project's engine
that property is load-bearing: the command set and the effect set are both enums,
so "we forgot to handle that" is a class of bug that can't reach a player.

## Slide 7 — Traits are interfaces that you can add later (1 min · flex cut)

*Visual: side-by-side.*

```ts
interface Combatant { attack(target: Target): void }
class Mob implements Combatant {          // must be declared at the class
  attack(target: Target) { /* ... */ }
}
```

```rust
trait Combatant { fn attack(&self, target: &mut Target); }

impl Combatant for Mob {                  // written separately from the type
    fn attack(&self, target: &mut Target) { /* ... */ }
}
```

Same idea as an interface, one upgrade: the implementation is written *apart*
from the type, so you can implement your own trait for a type you didn't define
— the sane version of patching `Array.prototype`, scoped to where you import it.
And `#[derive(Serialize)]` is one line that asks a library to write an
implementation for your type at compile time; that's how JSON works in Rust, and
it's the closest thing to a decorator you'll meet.

## Slide 8 — `async` looks identical and behaves differently (1 min)

*Visual: side-by-side.*

```js
const res = await fetch(url);   // the request is already in flight
```

```rust
let res = reqwest::get(url).await?;   // nothing happened until `.await`
```

Three differences worth 60 seconds:

- **Futures are lazy.** A JS promise starts running the moment you make it; a
  Rust future does nothing until it's awaited. Create-then-await-later behaves
  differently than you expect.
- **There's no event loop in the box.** Node ships one; Rust makes you pick a
  runtime, and the answer is `tokio` unless you know why it isn't.
- **`?` works here too**, so async error handling is the same one character.

Honest note: async is the sharpest corner of the language. A good default is to
keep async at the edges — the server, the I/O — and keep the core of your
program plain synchronous functions. That's exactly what this project does.

## Slide 9 — What it costs (45 s)

*Visual: two short columns.*

Pay the toll out loud, or nobody believes the rest:

- **The borrow checker will fight you for two or three weeks.** Everyone. Then
  it stops, because you start writing code that was going to be correct anyway.
- **Compile times are not `nodemon`.** Incremental builds are seconds; clean
  builds are minutes.
- **Fewer libraries than npm** — a lot fewer — but the ones that matter are
  unusually well-made, and `cargo` never gave you a `node_modules` to explain.

And the honest boundary: for glue, CRUD, and scripts, this ceremony buys you
nothing. Rust pays where correctness, portability, or performance is the
product.

## Slide 10 — The on-ramp (45 s)

*Visual: three lines and one suggestion.*

1. `rustup` — one installer, and it manages versions like `nvm`.
2. `cargo new` — start something small.
3. The Book (`doc.rust-lang.org/book`) — genuinely good, and free.

Best first project: **port a small utility you already wrote in JS.** You'll be
learning one thing (the language) instead of two (the language and the problem).
And if you want to see a real one, this project is public: a horror-RPG engine
whose Rust core runs in the browser, on a server, and on a physical board — the
architecture talks are in this same folder.

Closing line: *you already know half of it; the other half is three ideas and a
fortnight.*

---

## Timing checkpoints

- End of slide 2: ~2 min. Don't linger — the mapping table is reassurance, not
  content. Read three rows, not eight.
- End of slide 6: ~7 min 15. Slides 3 and 6 are the talk; if you are behind,
  take time from 4 and 5, not from these.
- Slide 7 (traits) is the **flex cut** (−1 min): drop it and go straight from
  `match` to `async` — nothing later depends on it.
- End of slide 8: ~9 min 15, leaving 90 seconds to land the cost slide and the
  on-ramp. Never cut slide 9; a Rust talk without the toll reads as a sales
  pitch.

## Q&A, if the slot has one

- **"Is it worth it just for wasm?"** If the JS is fast enough, no. Reach for it
  when you have a hot loop, a determinism requirement, or something you also
  need to run outside a browser.
- **"Can I use it with my existing stack?"** Yes, and that's the usual on-ramp:
  compile one module to wasm and call it from JS. `wasm-bindgen` generates the
  bindings.
- **"How long to productive?"** Two to four weeks for someone comfortable in
  TypeScript. The type system is the familiar part; ownership is the new part.
- **"What about TypeScript — doesn't it give me most of this?"** It gives you
  the shapes, and it's genuinely good at them. It doesn't give you exhaustive
  matching that fails a build, and its guarantees stop at runtime.
