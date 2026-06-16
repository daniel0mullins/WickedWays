# Introduction

Wicked Ways is a type-safe, turn-based tabletop RPG engine written in TypeScript.
It models a party-based horror campaign: a Game Master and player characters take
turns across a procedurally generated dungeon — fighting mobs, looting containers,
talking to NPCs, and accumulating damage across three interlocking stats. Game
rules are enforced both by the type system (branded IDs, hidden state) and at
runtime (lifecycle guards that throw on illegal moves).

## How these docs are organized

- **[Architecture](./architecture)** — the authoritative deep dive: the campaign
  turn loop, character hierarchy, combat and mitigation math, status effects,
  mobs and encounters, loot, crafting, durability, equipment slots, keys, and
  dialogue. This page mirrors the project's root `README.md`.
- **[API Reference](/api/)** — generated directly from the TSDoc comments in
  `src/lib`, so it always matches the current source.

## Using the engine

There is no published npm package yet. Import directly from the engine source
under `src/lib/...` — there is intentionally no barrel export. Start from
`src/lib/campaign.ts` (the campaign turn loop) and follow the types from there;
the [Architecture](./architecture) page walks through how the pieces fit.
