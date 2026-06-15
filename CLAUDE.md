# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A type-safe, turn-based tabletop RPG engine in TypeScript (`src/`). **`README.md` is the
authoritative architecture document** — it covers the campaign turn loop, character hierarchy,
combat/mitigation math, status effects, mobs/encounters, loot, crafting, durability, equipment
slots, keys, and dialogue in detail. Read it before making non-trivial changes; this file only
adds the operational and convention notes not spelled out there.

## Commands

```bash
npm run checks        # lint + typecheck + test, in sequence — run this before declaring work done
npm test              # vitest run (whole suite, once)
npm run typecheck     # tsc --noEmit
npm run lint:fix      # eslint --fix
npm run build         # compile to dist/ via tsconfig.build.json (excludes *.test.ts + test-utils)
```

Run a **single test file** or filter by name:

```bash
npx vitest run src/lib/character/mob.test.ts          # one file
npx vitest run -t "escape"                            # tests whose name matches "escape"
npx vitest src/lib/character/mob.test.ts              # watch a single file
```

Tests are co-located (`foo.ts` ↔ `foo.test.ts`); the cross-cutting suite is
`src/integration.test.ts`. Shared stubs/helpers live in `src/test-utils.ts`.

## Repo layout gotcha

This repo holds **two unrelated codebases**. The TypeScript engine is `src/`. The `landing/`
directory plus `vendor/`, `composer.json`, and `composer.lock` are a separate **PHP marketing
landing page** (Slim + Mailchimp subscribe form) — they are not part of the engine, not built by
`npm run build`, and unaffected by the TS tooling. `src/index.ts` is intentionally empty: there is
no barrel export, so consumers import directly from `src/lib/...`.

## Conventions that affect edits

- **Symbol seams for protected state.** Mutations that must not be forgeable are routed through
  exported `Symbol`s in `src/lib/inventory.ts` rather than public setters: `CLAIM`/`HELD_BY`
  (ownership), `SET_DURABILITY`, `EQUIP`/`UNEQUIP`, `DEPOSIT_MATERIALS`, `GRANT_IMMUNITY`,
  `CONSUME_VIA_USE`, `STASH_DROP`, `PLACE`, `SET_ORIGIN`. When adding state that external code
  shouldn't be able to spoof, follow this pattern (expose a getter, gate writes behind a symbol)
  instead of adding a public mutable field.

- **Action budget by method identity.** Only methods registered in a character's `isActionMap`
  count against the per-round budget; methods register themselves *by identity*, and
  `recordAction(fn)` ignores unregistered functions. Several actions (`craft`, `repair`, `equip`,
  `unequip`, `takeDamage`) are deliberately **free** (no budget tick, no history). Preserve a
  method's budgeted/free status when refactoring, and don't detach-and-call action methods
  (`unbound-method` is disabled precisely because they're passed as identity tokens).

- **Branded IDs** (`src/lib/brand.d.ts`) give `CampaignId`, `CharacterId`, `ItemId`, etc. distinct
  compile-time identities. Generate/convert through the proper helpers; don't cast a raw `string`
  into a branded id to silence the compiler.

- **Illegal operations throw `ProceduralViolation`** — lifecycle guards are intentional, not
  defensive noise. New illegal-state transitions should throw the same way.

- **All randomness goes through an injected `rng: () => number`** (constructor option), and dice
  via `roll(n, rng)` in `src/lib/dice.ts`. Keep new randomized logic on the injected rng so tests
  stay deterministic with a seeded generator.

## TypeScript strictness

`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, `NodeNext` resolution. Indexed access
yields `T | undefined` — handle the undefined case rather than asserting. Overrides must carry the
`override` keyword. Underscore-prefixed args/vars are exempt from the unused-vars rule (used for the
`set occupants(_)` style). Tests relax the `no-unsafe-*` rules for `as unknown as X` stubs.

## After adding a feature

Per the project's standing convention, update `README.md` (and any relevant TSDoc) to reflect new
mechanics before considering the work done — the README is treated as living documentation.
