# Cutover Cleanup: Lint Hygiene + Affliction Shake-off Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Green `pnpm lint` end-to-end without touching the edit-forbidden differential-gate authority, and add a dedicated conformance fixture that pins a persisted non-empty affliction `shakenOff` state (a Phase-1 coverage gap), diffed TS-oracle vs Rust.

**Architecture:** Two independent Phase-2 cutover-followup hygiene chores, structured as two task groups. **Chore A** (Tasks A1–A3) fixes the repo-root ESLint flat config (`eslint.config.mjs`) so `eslint .` exits 0: it ignores gitignored build-artifact dirs that leak parse errors, adds a scoped `conformance/**` override for the branded-id `no-unnecessary-type-assertion` rule (the only way to green the edit-forbidden `conformance/canonical-json.ts`), gives Node globals to the committed `scripts/**` `.mjs` CLI, and removes one unused import. **Chore B** (Tasks B1–B2) adds a new self-validating golden generator plus a replay harness that drives a Confused character through enough turns that the turn-start shake-off roll is guaranteed to land and persist in the serialized snapshot.

**Tech Stack:** TypeScript (NodeNext, strict), ESLint 9 flat config (`typescript-eslint` type-checked), Vitest, the Rust/WASM core (`crates/wickedways-wasm/pkg`, consumed via `replay_commands`), `mulberry32` seeded RNG.

## Global Constraints

- `pnpm lint` must exit 0 after chore A **WITHOUT editing `conformance/canonical-json.ts`** (edit-forbidden — differential-gate authority) and **without weakening lint for real `src/`/`packages/` source**.
- The differential gate is the authority: **fix Rust, never goldens** — but chore B expects a GREEN first-replay because the shake-off code is already proven byte-identical both sides; the fixture's job is COVERAGE, not catching a divergence.
- Every new `.gen.test.ts` generator MUST be registered in `conformance/fixtures/vitest.config.ts` (explicit include list). Replay tests (`conformance/*.test.ts`) are auto-discovered by `conformance/vitest.config.ts` (glob) — no registration needed.
- Chore B must produce **zero pre-existing golden churn** (no existing `conformance/fixtures/*.golden.json` may change).
- The `no_std` Rust core is unaffected by both chores (no Rust source is edited).

## File Structure

**Chore A (config + one source cleanup):**
- Modify: `eslint.config.mjs` — extend `ignores`; add a `scripts/**` Node-globals block; add a `conformance/**/*.ts` rule-override block.
- Modify: `conformance/fixtures/items-projection.gen.test.ts:32` — delete one unused import.

**Chore B (new fixture — mirrors the existing `afflictions` fixture layout):**
- Create: `conformance/fixtures/affliction-shakeoff.gen.test.ts` — the golden generator (seed-search + self-validation; writes the three JSON files below).
- Create (written by the generator, then committed): `conformance/fixtures/affliction-shakeoff.start.snapshot.json`, `conformance/fixtures/affliction-shakeoff.catalog.json`, `conformance/fixtures/affliction-shakeoff.golden.json`.
- Create: `conformance/affliction-shakeoff.test.ts` — the Rust-vs-oracle replay harness.
- Modify: `conformance/fixtures/vitest.config.ts` — add the generator to the explicit `include` list.

**Reference (READ, do not edit):**
- `conformance/canonical-json.ts` — edit-forbidden authority; line 32 (`Object.keys(value as Record<string, unknown>)`) is one of the `no-unnecessary-type-assertion` offenders → the reason A2 must be a scoped override, not a per-file cleanup.
- `conformance/fixtures/afflictions.gen.test.ts` — the existing affliction generator whose structure Task B1 mirrors (direct-drive `startTurn`/`nextPlayer`, `serializeCampaign`, `viewProjected`, `onCue` drain, self-validation-by-throw).
- `conformance/afflictions.test.ts` — the existing replay harness Task B2 mirrors.
- `crates/wickedways-core/src/world/afflictions.rs` (`on_turn_start`, `default_affliction_config`: Fear 40/30, Panic 20/20, Confused 15/15) and `src/lib/character/afflictions.ts` (`onTurnStart`) — the two sides the fixture pins.

---

## Chore A — Lint / ESLint Hygiene

**Verified starting state (`pnpm run lint`, exit ≠ 0). Error classes:**

| Class | Rule | Where | Fixed by |
|---|---|---|---|
| Parse error ("not found by the project service") | `null` (parser) | `crates/wickedways-core/bindings/*.ts` (gitignored ts-rs stray regen) | A1 (ignore) |
| `'exports' is not defined`, unused `_` | `no-undef`, `no-unused-vars` | `crates/wickedways-wasm/pkg-node/*`, `pkg-web/*` (gitignored WASM build artifacts) | A1 (ignore) |
| Branded-id `as ItemId`/`as CharacterId` casts | `@typescript-eslint/no-unnecessary-type-assertion` (32) | `conformance/**` incl. edit-forbidden `canonical-json.ts:32` | A2 (scoped override) |
| Unused `Directions` import | `@typescript-eslint/no-unused-vars` (1) | `conformance/fixtures/items-projection.gen.test.ts:32` | A2 (delete import) |
| `'console'/'process'/'Buffer' is not defined` | `no-undef` (8) | `scripts/assert-no-conformance.mjs` (committed; `js.configs.recommended` sets no globals for `.mjs`) | A3 (Node globals) |

> **Why more than the two headline problems:** the committed `scripts/assert-no-conformance.mjs` (`no-undef`) and the committed unused `Directions` import are *also* pre-existing-RED on a clean clone, and the gitignored `pkg-node/`/`pkg-web/` WASM artifacts leak the same way as `bindings/`. All are folded into chore A because the Global Constraint requires `pnpm lint` to exit 0 *after chore A*. `generated/bindings/` is already covered by the existing `generated/` ignore entry — no change needed for it (confirmed below).

### Task A1: Ignore gitignored build-artifact directories

**Files:**
- Modify: `eslint.config.mjs:8` (the `ignores` array)

**Interfaces:**
- Produces: nothing consumed by later tasks; independent config change.

- [ ] **Step 1: Write the failing test — prove a stray ts-rs regen breaks lint**

Simulate the stray `cargo test` ts-rs output the `.gitignore` (line 27, `/crates/wickedways-core/bindings/`) is meant to cover:

```bash
mkdir -p crates/wickedways-core/bindings
printf 'export type Stray = { a: number };\n' > crates/wickedways-core/bindings/Stray.ts
npx eslint crates/wickedways-core/bindings/Stray.ts
```

Expected: FAIL — `Parsing error: ... Stray.ts was not found by the project service.`

- [ ] **Step 2: Add the artifact dirs to `ignores`**

In `eslint.config.mjs`, replace the `ignores` line (line 8):

```js
    ignores: ["**/dist/", "**/coverage/", "**/node_modules/", "docs-site/", "**/pkg/", "generated/"],
```

with:

```js
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "docs-site/",
      "**/pkg/",
      // ts-rs stray output from a bare `cargo test` (gitignored; see .gitignore).
      "crates/wickedways-core/bindings/",
      // wasm-pack build artifacts (gitignored). `**/pkg/` does NOT match these.
      "**/pkg-node/",
      "**/pkg-web/",
      // Generated TS bindings (already gitignore-adjacent; covers generated/bindings/).
      "generated/",
    ],
```

- [ ] **Step 3: Run the test to verify the stray file is now ignored**

```bash
npx eslint crates/wickedways-core/bindings/Stray.ts
```

Expected: WARNING `File ignored because of a matching ignore pattern.` and **exit 0** (no parse error).

- [ ] **Step 4: Confirm `generated/bindings/` handling and clean up the stray file**

```bash
git check-ignore crates/wickedways-core/bindings generated/bindings; echo "check-ignore exit: $?"
rm -f crates/wickedways-core/bindings/Stray.ts; rmdir crates/wickedways-core/bindings 2>/dev/null || true
```

Expected: `crates/wickedways-core/bindings` prints (gitignored); `generated/bindings` does not print, but is covered by the `generated/` ESLint ignore entry above. Stray file removed.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): ignore gitignored ts-rs + wasm-pack build artifacts in eslint"
```

### Task A2: Scoped `conformance/**` override for `no-unnecessary-type-assertion` + drop unused import

**Files:**
- Modify: `eslint.config.mjs` (add a final override block)
- Modify: `conformance/fixtures/items-projection.gen.test.ts:32` (delete the unused import)

**Interfaces:**
- Consumes: A1's `ignores` (so the parse-error noise is already gone when observing this task's `pnpm lint` output).
- Produces: nothing later tasks import.

**Rationale (decision recorded):** the branded-id casts (`as ItemId`, `as CharacterId`, `value as Record<string, unknown>`) are an intentional conformance-harness pattern. `conformance/canonical-json.ts:32` is one of the 32 offenders **and is edit-forbidden** (differential-gate authority), so per-file cleanup cannot green it. A **scoped `conformance/**/*.ts` override** disabling only this one rule is therefore the required fix; it also clears the offenders in `canonical-json.ts`, `facade-catalog.ts`, and every `*.gen.test.ts` in one move, and leaves the rule fully active for `src/` and `packages/`. The single unused-import error is a different rule (`no-unused-vars`), so it is fixed by deleting the import (the file is editable) rather than by widening the override.

- [ ] **Step 1: Confirm the offenders (test = observe the two error classes)**

```bash
pnpm run lint 2>&1 | grep -E "no-unnecessary-type-assertion|Directions" | head
```

Expected: lines including `conformance/canonical-json.ts` ... `no-unnecessary-type-assertion` and `items-projection.gen.test.ts` ... `'Directions' is defined but never used`.

- [ ] **Step 2: Delete the unused import**

In `conformance/fixtures/items-projection.gen.test.ts`, delete line 32 in full:

```ts
import { Directions } from "wickedways/lib/room";
```

(Verify it is unused first: `grep -c "Directions" conformance/fixtures/items-projection.gen.test.ts` → `1`, i.e. the import line only.)

- [ ] **Step 3: Add the scoped conformance override**

In `eslint.config.mjs`, immediately before the final `);` that closes `tseslint.config(`, add:

```js
  // The conformance harness casts raw strings to branded ids (`as ItemId`,
  // `as CharacterId`) and narrows `unknown` with `as Record<string, unknown>` as
  // an intentional pattern; the type-aware rule flags them as unnecessary. This
  // scoped override is the only way to green conformance/canonical-json.ts
  // (edit-forbidden — the differential-gate authority) without touching it, and
  // it keeps the rule active for real src/ + packages/ source.
  {
    files: ["conformance/**/*.ts"],
    rules: { "@typescript-eslint/no-unnecessary-type-assertion": "off" },
  },
```

- [ ] **Step 4: Verify both error classes are gone**

```bash
pnpm run lint 2>&1 | grep -E "no-unnecessary-type-assertion|Directions"; echo "grep exit (1 = no matches = good): $?"
```

Expected: no output; `grep exit ... : 1`. (Full `pnpm lint` may still be non-zero here because of the `scripts/**` `no-undef` class fixed in A3.)

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs conformance/fixtures/items-projection.gen.test.ts
git commit -m "chore(lint): scope no-unnecessary-type-assertion off for conformance/** + drop unused import"
```

### Task A3: Node globals for committed `scripts/**` CLIs — and final green

**Files:**
- Modify: `eslint.config.mjs` (add a `scripts/**` languageOptions block)

**Interfaces:**
- Consumes: A1 (`ignores`) and A2 (override + import) so that this task's final `pnpm lint` reaches exit 0.

- [ ] **Step 1: Confirm the `no-undef` class (test)**

```bash
pnpm run lint 2>&1 | grep -E "assert-no-conformance.mjs|is not defined" | head
```

Expected: lines such as `scripts/assert-no-conformance.mjs ... 'console' is not defined`, `'process' is not defined`, `'Buffer' is not defined`.

- [ ] **Step 2: Add the Node-globals block for scripts**

`globals` is already imported at the top of `eslint.config.mjs` (`import globals from "globals";`). In `eslint.config.mjs`, immediately before the `conformance/**/*.ts` override added in A2 (still inside `tseslint.config(`), add:

```js
  // Node CLI scripts run under js.configs.recommended, which declares no globals,
  // so `console`/`process`/`Buffer` trip no-undef. Declare the Node globals for
  // them. This only ADDS names — it never relaxes a rule, so real source is
  // unaffected. (eslint.config.mjs itself needs no globals and is unchanged.)
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
```

- [ ] **Step 3: Verify `pnpm lint` is fully green (exit 0)**

```bash
pnpm run lint; echo "=== lint exit: $? ==="
```

Expected: `ESLint: No issues found` and `=== lint exit: 0 ===`.

- [ ] **Step 4: Confirm the whole checks gate still passes (lint is already its first step)**

```bash
pnpm run typecheck && echo "TYPECHECK OK"
```

Expected: `TYPECHECK OK` (no config change affects types). Note: `pnpm checks` runs `pnpm run lint` first, so greening lint unblocks the existing gate; no gate wiring is required. *Optional recommendation (do not force): add `pnpm run lint` to the head of the `checks:phase2` script in `package.json` so the Phase-2 gate also enforces lint — leave to reviewer discretion.*

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): give Node globals to scripts/** and green pnpm lint (exit 0)"
```

---

## Chore B — Affliction Shake-off Differential Fixture

**Background (verified):** every committed affliction golden serializes `shakenOff: []` — `grep -o '"shakenOff": \[[^]]*\]' conformance/fixtures/afflictions.golden.json | grep -vc '"shakenOff": \[\]'` returns `0`. The shake-off roll lives in `afflictions.rs::on_turn_start` (and its TS mirror `afflictions.ts::onTurnStart`): for each active clearable, in `CLEARABLE` order `[Panic, Fear, Confused]`, `turns += 1`, `p = clamp(base + increment*(turns-1), 0, 100)`, and `roll(100, rng) <= p` pushes the status into `shakenOff`. Because a shaken-off status is set inactive but its episode is **not** cleared while its stat stays below threshold (`resolve`: `active = !shakenOff.has(s)`, no `clear_episode`), `shakenOff` **persists** into every subsequent snapshot. This fixture drives a Confused character (energy 0, never recovered) so `shakenOff: ["confused"]` is guaranteed to appear and persist. Config: Confused clears at `15% + 15/turn`, so by the character's 8th turn `p = 15 + 15*6 = 105 → clamp 100` — a shake-off is guaranteed regardless of seed; the seed search below simply picks the first seed that lands one (and hard-throws if none does).

### Task B1: The shake-off golden generator + generated fixtures

**Files:**
- Create: `conformance/fixtures/affliction-shakeoff.gen.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (register the generator)
- Create (written by the generator): `conformance/fixtures/affliction-shakeoff.start.snapshot.json`, `conformance/fixtures/affliction-shakeoff.catalog.json`, `conformance/fixtures/affliction-shakeoff.golden.json`

**Interfaces:**
- Produces: `affliction-shakeoff.golden.json` shaped `{ seed: number; commands: Command[]; steps: Array<{ command; cues; snapshot; view }> }`, `affliction-shakeoff.start.snapshot.json` (a `serializeCampaign` snapshot string), and `affliction-shakeoff.catalog.json` = `{ items: {}, aliases: {} }` — all consumed by Task B2's replay harness. `Command = { kind: "startTurn" } | { kind: "nextPlayer" }`.

- [ ] **Step 1: Write the generator (the failing "test" is the self-validating generator itself)**

Create `conformance/fixtures/affliction-shakeoff.gen.test.ts`:

```ts
/**
 * Affliction shake-off golden generator — run once to write the committed fixture files.
 *
 * COVERAGE fixture (Phase-1 gap): every other committed affliction golden has
 * `shakenOff: []`. This one drives a single Confused character (energy 0, never
 * recovered) through enough turns that the turn-start shake-off roll is GUARANTEED
 * to land (Confused odds reach 100% by the 8th turn) and — because the episode is
 * never cleared — PERSISTS a non-empty `shakenOff` in the serialized snapshot.
 *
 * Two PCs, both in one lit Hall, no items/loot/encounters (baseEncounterChance 0),
 * so the ONLY rng draws are Ada's Confused clear rolls (one per Ada startTurn after
 * the latch). All draws come from a single shared `mulberry32(SEED)` instance —
 * mirroring the Rust World's single `pub rng: Rng` seeded via `replay_commands`.
 * The start snapshot is serialized BEFORE the first startTurn (nothing draws at boot).
 *
 * Writes: affliction-shakeoff.start.snapshot.json / .catalog.json / .golden.json.
 * Run via: pnpm run fixtures:gen  (excluded from the replay gate; see conformance/vitest.config.ts)
 *
 * Replay contract (Task B2): each `golden.commands` entry deserializes into the
 * Rust Command enum: { "kind": "startTurn" } | { "kind": "nextPlayer" }.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import type { PresentationCue } from "wickedways/lib/presentation";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

type Command = { kind: "startTurn" } | { kind: "nextPlayer" };

// 8 rounds. Each round: Ada.startTurn (1 Confused clear roll after the latch) →
// nextPlayer → Ben.startTurn (Ben has no afflictions → 0 draws) → nextPlayer.
// By Ada's 8th startTurn the Confused clear odds hit 100% (15 + 15*6 → clamp 100),
// so a shake-off is guaranteed to land and persist (energy stays 0 → never cleared).
const COMMANDS: Command[] = [];
for (let r = 0; r < 8; r++) {
  COMMANDS.push({ kind: "startTurn" }); // Ada
  COMMANDS.push({ kind: "nextPlayer" }); // → Ben
  COMMANDS.push({ kind: "startTurn" }); // Ben (0 draws)
  COMMANDS.push({ kind: "nextPlayer" }); // → next round, Ada
}

// Two archetypes: Ada = energy 0 → Confused (the sole clearable); Ben = all healthy.
function buildCampaign(rng: () => number) {
  const registry = defineRegistry({ items: {} });
  const template = authorTemplate("Affliction shake-off (conformance)", registry, {
    rng,
    maxRounds: 40,
    baseEncounterChance: 0,
  })
    .archetype({
      id: "rattled",
      name: "Rattled",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 0, // energy<=0 → Confused
      },
    })
    .archetype({
      id: "steady",
      name: "Steady",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10, // no afflictions
      },
    })
    .room("Hall", { description: "A cold stone hall." })
    .startRoom("Hall");

  const { campaign, rooms } = assemble(template.description, template.registry);
  const hall = rooms.get("Hall")!;

  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  ada.joinCampaign();
  ada.selectArchetype("rattled" as never);
  ada.move(hall);

  const ben = new PlayerCharacter({ campaign, name: "Ben", rng });
  ben.id = "player:Ben" as CharacterId;
  ben.joinCampaign();
  ben.selectArchetype("steady" as never);
  ben.move(hall);

  campaign.gm = ada;
  campaign.beginCampaign();
  return campaign;
}

type Step = { command: Command; cues: PresentationCue[]; snapshot: unknown; view: unknown };

function driveAndCapture(seed: number): { start: unknown; steps: Step[] } {
  const rng = mulberry32(seed);
  const campaign = buildCampaign(rng);
  const start = serializeCampaign(campaign); // pre-command; no rng drawn yet

  let buf: PresentationCue[] = [];
  campaign.onCue((c: PresentationCue) => buf.push(c));
  const drain = () => {
    const out = buf;
    buf = [];
    return out;
  };

  const steps = COMMANDS.map((cmd) => {
    switch (cmd.kind) {
      case "startTurn":
        campaign.activeCharacter.startTurn();
        break;
      case "nextPlayer":
        campaign.nextPlayer();
        break;
    }
    return {
      command: cmd,
      cues: drain(),
      snapshot: serializeCampaign(campaign),
      view: viewProjected(campaign),
    };
  });
  return { start, steps };
}

// Load-bearing predicate: some step's snapshot has a character with a non-empty
// shakenOff — the whole reason this fixture exists.
function persistsShakenOff(steps: Step[]): boolean {
  return steps.some((s) => {
    const chars =
      (s.snapshot as { characters?: Array<{ afflictions?: { shakenOff?: unknown[] } }> })
        .characters ?? [];
    return chars.some((ch) => (ch.afflictions?.shakenOff?.length ?? 0) > 0);
  });
}

describe("generate affliction shake-off golden", () => {
  it("writes a golden whose snapshot persists a non-empty shakenOff", () => {
    let chosen: { seed: number; start: unknown; steps: Step[] } | null = null;
    for (let seed = 1; seed <= 200; seed++) {
      const { start, steps } = driveAndCapture(seed);
      if (persistsShakenOff(steps)) {
        chosen = { seed, start, steps };
        break;
      }
    }
    if (!chosen) {
      throw new Error(
        "No seed in 1..200 produced a persisted non-empty shakenOff — lengthen the stream.",
      );
    }
    // Redundant hard-throw guarding the coverage contract (see file header).
    if (!persistsShakenOff(chosen.steps)) {
      throw new Error("Chosen golden lacks a non-empty shakenOff (self-validation failed).");
    }

    const catalog = { items: {}, aliases: {} }; // no items → empty catalog

    writeFileSync(
      join(here, "affliction-shakeoff.start.snapshot.json"),
      JSON.stringify(chosen.start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "affliction-shakeoff.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "affliction-shakeoff.golden.json"),
      JSON.stringify({ seed: chosen.seed, commands: COMMANDS, steps: chosen.steps }, null, 2) + "\n",
    );

    console.log(`[affliction-shakeoff] SEED=${chosen.seed} steps=${chosen.steps.length}`);
  });
});
```

- [ ] **Step 2: Register the generator in the fixtures vitest config**

In `conformance/fixtures/vitest.config.ts`, add this line to the `include` array (e.g. right after the `afflictions.gen.test.ts` entry):

```ts
      "conformance/fixtures/affliction-shakeoff.gen.test.ts",
```

- [ ] **Step 3: Run ONLY this generator (avoid churning other goldens)**

```bash
pnpm vitest run --config conformance/fixtures/vitest.config.ts conformance/fixtures/affliction-shakeoff.gen.test.ts
```

Expected: PASS (1 test), with a console line `[affliction-shakeoff] SEED=<n> steps=32`. If it THROWS "No seed ... produced a persisted non-empty shakenOff", the stream is too short — increase the loop bound in `COMMANDS` (`r < 8` → `r < 10`) and rerun. (`viewProjected(campaign)` uses default empty aliases/opened — no items exist.)

- [ ] **Step 4: Verify the generated golden actually persists a non-empty shakenOff, and other goldens are untouched**

```bash
grep -o '"shakenOff": \[[^]]*\]' conformance/fixtures/affliction-shakeoff.golden.json | grep -v '"shakenOff": \[\]' | head
git status --short conformance/fixtures
```

Expected: at least one `"shakenOff": ["confused"]` line printed; `git status` shows ONLY the three new `affliction-shakeoff.*` files plus the generator and the modified `vitest.config.ts` — **no existing `*.golden.json` modified**.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/affliction-shakeoff.gen.test.ts \
        conformance/fixtures/affliction-shakeoff.start.snapshot.json \
        conformance/fixtures/affliction-shakeoff.catalog.json \
        conformance/fixtures/affliction-shakeoff.golden.json \
        conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): affliction shake-off golden generator (persists non-empty shakenOff)"
```

### Task B2: The Rust-vs-oracle replay harness

**Files:**
- Create: `conformance/affliction-shakeoff.test.ts`

**Interfaces:**
- Consumes: B1's `affliction-shakeoff.start.snapshot.json`, `.catalog.json`, `.golden.json`, and the WASM `replay_commands(start_snapshot_json, commands_json, catalog_json, seed) => string` from `crates/wickedways-wasm/pkg/wickedways_wasm.js`.

- [ ] **Step 1: Write the replay test**

Create `conformance/affliction-shakeoff.test.ts` (mirrors `conformance/afflictions.test.ts`, plus an explicit coverage assertion):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (
    start_snapshot_json: string,
    commands_json: string,
    catalog_json: string,
    seed: number,
  ) => string;
};

const start = readFileSync(
  join(here, "fixtures/affliction-shakeoff.start.snapshot.json"),
  "utf8",
);
const catalogJson = readFileSync(
  join(here, "fixtures/affliction-shakeoff.catalog.json"),
  "utf8",
);
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/affliction-shakeoff.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("affliction shake-off differential conformance", () => {
  it("Rust replay matches the TS oracle per step and persists a non-empty shakenOff", () => {
    // Coverage guard: the golden must actually contain a non-empty shakenOff.
    const hasShaken = golden.steps.some((s) => {
      const chars =
        (s.snapshot as { characters?: Array<{ afflictions?: { shakenOff?: unknown[] } }> })
          .characters ?? [];
      return chars.some((ch) => (ch.afflictions?.shakenOff?.length ?? 0) > 0);
    });
    expect(hasShaken, "golden must persist a non-empty shakenOff").toBe(true);

    const out = JSON.parse(
      wasm.replay_commands(
        start,
        JSON.stringify(golden.commands),
        catalogJson,
        golden.seed,
      ),
    ) as Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;

    expect(out.length).toBe(golden.steps.length);
    out.forEach((step, i) => {
      const want = golden.steps[i]!;
      expect(canonicalize(step.cues), `step ${i} cues`).toEqual(canonicalize(want.cues));
      expect(canonicalize(step.snapshot), `step ${i} snapshot`).toEqual(
        canonicalize(want.snapshot),
      );
      expect(canonicalize(step.view), `step ${i} view`).toEqual(canonicalize(want.view));
    });
  });
});
```

- [ ] **Step 2: Run the replay against the freshly-built Rust core**

```bash
pnpm run wasm:build:conformance
pnpm vitest run --config conformance/vitest.config.ts conformance/affliction-shakeoff.test.ts
```

Expected: PASS. Because the shake-off code is already byte-identical both sides, this is GREEN on first replay (the value is the pinned coverage, not catching a divergence). If it were to FAIL on the snapshot diff, the divergence is a Rust bug — fix `crates/wickedways-core/src/world/afflictions.rs`, never the golden (Global Constraints).

- [ ] **Step 3: Run the whole conformance gate to confirm no regression**

```bash
pnpm run test:conformance
```

Expected: all conformance replay tests PASS, including `affliction-shakeoff.test.ts` (auto-discovered via the `conformance/**/*.test.ts` glob).

- [ ] **Step 4: Confirm lint is still green over the new files**

```bash
pnpm run lint; echo "=== lint exit: $? ==="
```

Expected: `ESLint: No issues found`, exit 0 (the new `conformance/**` files are covered by the A2 override for the branded-id rule).

- [ ] **Step 5: Commit**

```bash
git add conformance/affliction-shakeoff.test.ts
git commit -m "test(conformance): affliction shake-off differential replay (Rust vs oracle)"
```

---

## Self-Review

- **Spec coverage.** Chore A problem 1 (gitignored `bindings/` leak) → Task A1, which also handles the same-class `pkg-node/`/`pkg-web/` leak and confirms `generated/bindings/`. Chore A problem 2 (`no-unnecessary-type-assertion` incl. edit-forbidden `canonical-json.ts`) → Task A2 scoped override (decision: override, because the file is edit-forbidden and is a confirmed offender). Two additional pre-existing-RED blockers required by the "exit 0" constraint — the committed `scripts/**` `no-undef` and the unused `Directions` import — are covered by A3 and A2 respectively. Chore B (persisted non-empty `shakenOff` differential fixture with seed search + self-validation, registered in `conformance/fixtures/vitest.config.ts`, zero golden churn, GREEN first-replay) → Tasks B1–B2.
- **Placeholder scan.** No TBD/TODO; every code and config step shows the exact content; every command has an expected output. The one variable value (the chosen seed) is deterministically resolved by the generator's search and printed at gen time, not left as a placeholder.
- **Type/name consistency.** `Command`, `Step`, `driveAndCapture`, `persistsShakenOff`, and the three `affliction-shakeoff.*` filenames match between B1 (generator) and B2 (replay harness); the `replay_commands` signature matches `conformance/afflictions.test.ts`. The archetype ids (`rattled`, `steady`) and stat keys are consistent within B1.
- **Edit-forbidden respected.** `conformance/canonical-json.ts` is never edited; it is greened solely by the A2 scoped override. No Rust source is edited (`no_std` core unaffected).
