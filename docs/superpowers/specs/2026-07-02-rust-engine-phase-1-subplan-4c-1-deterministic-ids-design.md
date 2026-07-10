# Rust Engine — Phase 1, Sub-plan 4c-1: Deterministic (Content-Derived) Entity IDs — Design

**Status:** Approved (design), pending spec review
**Date:** 2026-07-02
**Parent:** Sub-plan 4c (mobs/encounters/escape/drops), split into **4c-1 (deterministic
entity ids — this doc)** and **4c-2 (mob defeat drops)**. 4c-1 is a prerequisite refactor;
4c-2 builds on it.

## Goal

Replace the TypeScript oracle's non-deterministic `uuid()` entity ids with **content-derived**
ids computed from each entity's authoring context — deterministic, order-robust, readable,
and safe for multiple live campaigns in one process (no shared mutable state). Regenerate
every conformance fixture so ids are stable. No game mechanic changes, and **no Rust core
changes** (the Rust engine reads ids as opaque strings).

## Why

Two problems converge:

1. **Reviewability (process debt):** every `pnpm run fixtures:gen` re-mints random UUIDs, so
   regenerating a fixture churns its whole golden — golden diffs have been effectively
   unreviewable since sub-plan 3a.
2. **Multiple live campaigns (correctness):** the engine will host several campaigns in one
   process. Any *global mutable* id source (a module counter, or a shared `uuid()` sequence
   whose order matters) makes per-campaign ids depend on interleaving across campaigns —
   non-deterministic and fragile. A **content-derived** scheme has no shared state: each
   campaign derives its own ids purely from its own authoring data.

Content-derived ids solve both: genesis ids become stable *and* readable (`room:hall`,
`mob:wraith`), and independent campaigns never interfere.

This also unblocks **4c-2's replay-time loot-box mint**, which uses the same context-derived
principle (`${mob.id}:remains`) so the id matches byte-for-byte between the TS oracle and the
Rust replay with no counter or serialized state.

## Non-goals / key simplifications

- **No global counter, no per-campaign counter, no `idCounter` snapshot field.** Ids are
  functions of authoring/mint context, not of a running count.
- **No Rust core changes in 4c-1.** Genesis id generation is TS-only (Rust reads ids from the
  snapshot as opaque strings; the serializer and `conformance/canonical-json.ts` never parse
  id format). 4c-1 = TS refactor + fixture regeneration + gate verification.
- **Runtime minting (the loot box) is 4c-2**, not 4c-1. 4c-1 does not touch runtime minting.

## Architecture

The **assembler** (`src/lib/authoring/assembler.ts`) already holds every entity's unique
authoring key at construction and validates uniqueness-within-kind (pass 1). It becomes the
single place that assigns each genesis entity a content-derived id. Entities already permit
id assignment (the hydration paths set `entity.id` post-construction), so the assembler
assigns ids from context rather than letting constructors call `generateId()`/`uuid()`.

Entity ids are opaque strings used only for equality and as map keys — never parsed — so the
format change from a 36-char UUID to `kind:name` is behaviourally inert (verified against the
serializer BFS and the canonical-JSON comparator).

## Tech Stack

TypeScript oracle (`src/`); Rust `no_std` core + wasm (unchanged this sub-plan); serde,
ts-rs, vitest, pnpm. Gate: `pnpm run checks:phase3` = `cargo build -p wickedways-core
--no-default-features` + `cargo test --workspace` + `pnpm run bindings:check` + `pnpm run
test:conformance`.

## Global Constraints

- **The differential gate is the authority.** After regeneration, any divergence is fixed in
  Rust source (there should be none — Rust is unchanged), never by hand-editing goldens or
  `conformance/canonical-json.ts`.
- **No mechanic changes.** The only legitimate golden difference is id *strings* changing
  `uuid → content-derived`. There is **no new field** (no `idCounter`). Any non-id golden
  change is a bug.
- **No shared mutable id state.** Ids derive from authoring/mint context. Two campaigns
  assembled in the same process must produce their own ids with zero cross-interference.
- **Content-derived id forms** (the cross-cutting contract):
  - Uniquely-keyed kinds: `` `${kind}:${name}` `` — `room:`, `mob:`, `loot:`, `cache:`, `npc:`.
  - Exit: `` `exit:${[fromName, toName].sort().join("|")}` `` (per unordered room-pair, matching
    the existing dedup) — plus the direction only if two exits can share a pair (they cannot;
    dedup keeps one per pair).
  - Scene: `` `scene:${room}:${behaviorKey}:${phase}` ``.
  - Multi-instance items: `` `${parentId}:${role}#${index}` `` where `parentId` is the parent's
    content-derived id, `role ∈ {item, drop, light}`, and `index` is the 0-based position in
    the parent's array (`loot.items` / `mob.drops` / `room.lights`). Kind-prefixing prevents
    any cross-kind collision.
  - Campaign: **caller-provided** (see §2).
- **Rust reads ids opaquely.** No Rust code may assume or parse the `kind:name` form.
- **`no_std` core** unchanged; unit tests run under DEFAULT features; no_std verified by build.

## 1. Content-derived genesis ids (TS assembler)

In `src/lib/authoring/assembler.ts` pass 2, assign each constructed entity its content-derived
id (author name/context already in scope):

- **MaterialCache** (`caches.set(c.name, …)`): `cache.id = `cache:${c.name}``.
- **Loot** (`loot.set(l.name, …)`): `loot.id = `loot:${l.name}``; then for each item in
  `l.items` at index `i`: `item.id = `loot:${l.name}:item#${i}``.
- **Mob** (`mobs.set(m.name, …)`): `mob.id = `mob:${m.name}``; then for each drop in `m.drops`
  at index `i`: `dropItem.id = `mob:${m.name}:drop#${i}``.
- **Room** (`rooms.set(r.name, …)`): `room.id = `room:${r.name}``; then for each light in
  `r.lights` at index `i`: `lightItem.id = `room:${r.name}:light#${i}``.
- **Exit** (created in `Room.addExit`): after wiring, set `exit.id =
  `exit:${[e.from, e.to].sort().join("|")}``.
- **Scene** (`registerScene`): `scene.id = `scene:${s.room}:${s.key}:${s.phase ?? "enter"}``.
- **NPC** (`npcs`): `npc.id = `npc:${n.name}``.

**Player-characters** are created *outside* the assembler — in `startSession`
(`orchestration.ts`) and, in the conformance generators, by manual `new PlayerCharacter(...)`
(the gen fixtures construct PCs directly to inject a seeded rng). PCs therefore get their
content-derived id at *that* construction site, not in the assembler: `` `player:${name}` `` (a
distinct prefix from `mob:` so a PC and a mob sharing a name never collide). This is done by
giving `CharacterOptions`/`PlayerCharacter` an injectable id (same pattern as the campaign id
in §2); orchestration and the fixtures pass `` `player:${name}` ``.

Mechanics:
- The assembler reaches into each parent's freshly-constructed sub-entity collection
  (`loot.contents`, `mob.inventory.items`, `room.lightSources`) to assign item ids by index —
  arrays preserve the template order, so the index is stable.
- `generateId()` and the bare `uuid()` in the `Item` constructor (`inventory.ts:535`) are no
  longer the source of genesis ids; the assembler is. (Whether `generateId`/`uuid` remain for
  any non-assembled path is decided in the plan; assembled genesis entities get
  content-derived ids.)
- Assign room ids before exit ids so any id-based bookkeeping is consistent; the exit id
  itself derives from author room *names*, not room ids, so it is order-independent.

## 2. Campaign id — caller-provided

A campaign has only a (non-unique) title, so its id cannot be content-derived
deterministically-and-uniquely. Add `id?: CampaignId` to `CampaignOptions` (`campaign.ts`):
- If provided, use it.
- If omitted, derive a stable fallback `` `campaign:${title}` `` (sufficient for
  single-campaign fixtures, whose titles are fixed).

The conformance generators/authoring pass an explicit fixed campaign id (or rely on the
title-derived fallback). A real multi-campaign host passes a unique session id per campaign —
the app owns campaign identity. No `uuid()` for the campaign id in the deterministic path.

## 3. Runtime minting — deferred to 4c-2 (context-derived)

The first replay-time mint is 4c-2's loot box in `Mob.onKnockOut`, which will use
`` `${mob.id}:remains` `` — derived from the already-unique mob id, identical in TS and Rust by
construction, stateless, multi-campaign-safe. 4c-1 establishes the *principle* (content-derived
ids) but implements no runtime mint; 4c-2 adds it on both sides.

## 4. Fixture regeneration + stability guarantee

`pnpm run fixtures:gen` regenerates **every** gen-produced fixture with content-derived ids:
`conformance/fixtures/turn-movement.*`, `items-actions.*`, `items-projection.*`,
`afflictions.*`, `combat.*`, `seed.snapshot.json`, `hollow-house.snapshot.json`, and any
world-roundtrip input snapshots produced by a generator.
- **One-time churn**: every golden's ids flip `uuid → content-derived`. **No field is
  added.** Verify by normalizing ids (`s/(room|mob|loot|cache|npc|exit|scene|item|campaign):[^"]*|[0-9a-f-]{36}/ID/`)
  that nothing but id strings changed — proving no mechanic moved.
- Hand-authored-id fixtures (if any) are unaffected.

**Stability win:** after regeneration, a second `fixtures:gen` yields **byte-identical**
goldens (no `git diff`). This is the acceptance property that retires the churn debt.

## 5. Verification

- **`pnpm run checks:phase3` EXIT 0**, with **no Rust source changes**: Rust replays the
  regenerated content-derived-id snapshots and matches every golden per step (ids are opaque),
  `cargo test --workspace` green, no_std build clean, bindings drift-clean (no id-related
  binding changes — id fields are already `string`).
- **Regenerate-twice stability test**: a check that runs `fixtures:gen` twice and asserts
  `git diff --exit-code conformance/fixtures/` is clean the second time.
- **Semantic-inertness spot check**: id-normalized diff of a pre-4c-1 vs regenerated golden is
  empty — proving only ids changed.
- **Multi-campaign determinism unit test (TS)**: assemble the same template twice (and two
  different templates) in one process; assert each assembly yields identical, non-interfering
  ids (e.g. `room:hall` regardless of how many campaigns were built before).

## 6. File structure

**TS oracle (modify):**
- `src/lib/authoring/assembler.ts` — assign content-derived ids to every constructed genesis
  entity (rooms, mobs, loot, caches, npcs, exits, scenes) and their contained items.
- `src/lib/campaign.ts` — `CampaignOptions.id?` + title-derived fallback.
- `src/lib/util.ts` / `src/lib/inventory.ts:535` — retire `uuid()` as the genesis id source
  for assembled entities (exact treatment of `generateId`/`Item` decided in the plan; assembled
  entities no longer depend on it).
- `src/lib/authoring/orchestration.ts` — thread the campaign id through `startSession`; assign
  each PlayerCharacter `player:${name}`.
- `src/lib/character/character.ts` — `CharacterOptions.id?` (injectable) so PC/mob construction
  sites provide content-derived ids instead of the constructor minting one.
- The conformance generators (`conformance/fixtures/*.gen.test.ts`) that construct PCs manually
  pass `id: `player:${name}``.

**Rust core:** **none.**

**Fixtures (regenerate):** all gen-produced `conformance/fixtures/*` goldens + start
snapshots. **Add:** the regenerate-twice stability check and the multi-campaign determinism
unit test.

**Docs:** a short note on the content-derived id scheme (forms per kind; campaign id
caller-provided).

## 7. Task decomposition shape (~5 tasks)

1. **Assembler content-derived ids for uniquely-keyed entities** — rooms, mobs, loot, caches,
   npcs, scenes: `${kind}:${name}` / composite. TS unit test: assembling a template yields the
   expected readable ids, stable across two builds.
2. **Multi-instance item ids + exit ids** — `${parentId}:${role}#${index}` for loot/mob/room
   items; `exit:${sorted pair}`. Unit test: a container with a repeated item key yields
   `…:item#0`, `…:item#1`; a bidirectional exit yields one shared `exit:…` id.
3. **Campaign + player-character ids caller-provided** — `CampaignOptions.id?` (+ title
   fallback) and `CharacterOptions.id?`; orchestration + the gen fixtures pass
   `campaign:…`/`player:${name}`. Retire `uuid()`/`generateId` as the genesis id source. Unit
   test: explicit ids honored; PC gets `player:${name}`; a PC and mob sharing a name get
   distinct ids.
4. **Regenerate all fixtures + `checks:phase3` green** — `fixtures:gen`; confirm the full gate
   is green with **no Rust changes**; id-normalized diff shows only ids changed.
5. **Stability + multi-campaign tests + docs** — regenerate-twice byte-identical check; the
   multi-campaign determinism unit test; docs note.

## Out of scope (4c-2 and later)

- **Runtime entity minting** (loot box `${mob.id}:remains`, future crafted items / spawned
  mobs) — 4c-2 and beyond, all context-derived.
- **Mob defeat drops, encounter cues, `sees_in_dark`** — 4c-2.
- **Encounter spawning, escape, mob-AI turns** — sub-plan 6 (registry / mob turns).
