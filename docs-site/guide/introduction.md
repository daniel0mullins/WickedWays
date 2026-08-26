# Introduction

Wicked Ways is a turn-based tabletop horror-RPG engine written in Rust and
shipped as a wasm-compiled web client. It models a party-based horror campaign:
a Game Master and player characters take turns across an authored house of
rooms — fighting mobs, looting containers, talking to NPCs, and accumulating
damage across three interlocking stats. Game rules are enforced both by the
type system (branded IDs, private state) and at runtime (lifecycle guards that
throw `ProceduralViolation` on illegal moves).

The engine lives in a Rust workspace under `crates/`:

| Crate | Role |
|---|---|
| `wickedways-core` | The engine: world state, turn loop, combat, mechanics, the ops DSL, sync. |
| `wickedways-author` | Compiles the TOML campaign-author format into a description + catalog. |
| `wickedways-assemble` | Assembles a description + catalog (+ seated party) into a genesis snapshot. |
| `wickedways-wasm` | The wasm-bindgen boundary: the stateful `Authority` handle. |
| `wickedways-transport` | The multiplayer wire protocol. |
| `wickedways-server` | The axum room server: per-campaign table actors, seat auth, persistence. |
| `wickedways-web` | The Dioxus web client — the shipped product. |

## How these docs are organized

- **[Getting started](./getting-started)** — build and run the engine from a
  fresh checkout, then a guided tour of every concept with runnable code: the
  authoring pipeline, the `World` and its snapshots, turns and lifecycle
  guards, intents and cues, damage and determinism, the behavior-trait pattern
  and the ops DSL, multiplayer sync, and the golden gates.
- **[Architecture](./architecture)** — the authoritative deep dive: the campaign
  turn loop, character hierarchy, combat and mitigation math, status effects,
  mobs and encounters, loot, crafting, durability, equipment slots, keys, and
  dialogue. This page mirrors the project's root `README.md`.

## Authoring campaigns

Campaigns are authored in a declarative TOML format compiled by
`wickedways-author`: rooms, exits, loot, mobs, NPCs, scenes, victory
conditions, items, and scripted behaviors in one file. The complete shipped
campaign (`campaigns/hollow-house.toml`) doubles as the reference
example, and the [Architecture](./architecture) page documents the format
alongside the mechanics it drives.
