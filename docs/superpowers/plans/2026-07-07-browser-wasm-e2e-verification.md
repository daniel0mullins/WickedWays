# Browser WASM E2E Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove — at runtime in a real browser — that the single-player game boots and plays hollow-house through the WASM `Authority` (async `initEngine()` resolves → synchronous `Authority` construction → menu → surface → in-game turns), closing the Phase-2 cutover gap where the browser bundler path was build-verified only.

**Architecture:** The Playwright suite `packages/play/e2e/playthrough.spec.ts` already drives the full app (CRT + PnC winning playthroughs, boot, menu, surface picker, themes) and its `webServer` runs `pnpm dev` (Vite) — which resolves `#engine` to the `browser` condition (`engine-web.ts`) and loads the bundler-target `pkg-web` build. So post-cutover, that suite *already* exercises the WASM `Authority` at runtime; it has simply never been run against the cutover build in a gate. This plan (1) makes a fresh `pkg-web` build a prerequisite of the e2e run, (2) adds a focused WASM-boot smoke spec that fails loudly on any `engine not initialized` / wasm-load error, and (3) runs the full existing suite green, wires it into a dedicated CI job, and flips the README from "build-verified" to "runtime-verified".

**Tech Stack:** Playwright (`@playwright/test` ^1.61.1, chromium project), Vite ^8 dev server (port 5174), `vite-plugin-wasm` + `vite-plugin-top-level-await`, `wasm-pack` (bundler target → `pkg-web`), pnpm workspaces (`pnpm@9.15.6`), GitHub Actions.

## Global Constraints

- Playwright chromium runs against `pnpm dev` (Vite, port 5174, the bundler-target WASM build).
- The engine is the authority — if the e2e diverges, fix the SPEC/test, not the engine (engine changes go through the differential gate `pnpm run test:conformance`).
- The browser build is the DEFAULT (no-conformance) wasm build (`wasm:build:web` → `pkg-web`); do NOT introduce the `conformance` feature into the browser path.
- Do NOT make `GameSession.start` async — only the launcher awaits `initEngine()` once, inside `bootLauncher`.
- If this environment cannot run headed/headless chromium, each e2e task must still be runnable by a human/CI: build-verify locally, run e2e in CI. Every e2e step below carries a "Run" command **and** a "Fallback (no chromium here)" note.

## File Structure

- **Modify** `packages/play/package.json` — add a `pretest:e2e` script so a fresh `pkg-web` is built before Playwright starts the Vite dev server.
- **Create** `packages/play/e2e/wasm-boot.spec.ts` — focused WASM-boot smoke spec (deep-link boot + full menu→picker→surface boot), asserting no `engine not initialized`/wasm/WebAssembly console or page errors and that the first room renders.
- **Modify** `package.json` (repo root) — add a `test:e2e` convenience script that filters the play package.
- **Create** `.github/workflows/e2e.yml` — a dedicated CI job (Rust toolchain + wasm-pack + Playwright chromium) that runs the browser e2e; kept OUT of the fast `pnpm run checks` gate.
- **Modify** `README.md` — flip the Phase-2 "Scope / known gaps" note from "build-verified only" to runtime-verified once the suite is green.
- **Modify** `packages/play/e2e/playthrough.spec.ts` — ONLY if Task 3 finds a WASM-boundary-induced failure; the fix goes in the spec, never the engine.

---

### Task 1: Make a fresh `pkg-web` build a prerequisite of the e2e run

Playwright's `webServer.command` is `pnpm dev` (bare `vite`); there is no `predev`, and `crates/wickedways-wasm/pkg-web/` is gitignored (`*`) — a build artifact, absent on a fresh checkout. `engine-web.ts` statically imports `../../../crates/wickedways-wasm/pkg-web/wickedways_wasm.js`, so Vite fails to resolve the module unless `pkg-web` exists. Wire the browser wasm build to run automatically before `test:e2e` so the browser always loads a freshly-built WASM `Authority`.

**Files:**
- Modify: `packages/play/package.json:6-11` (the `scripts` block)

**Interfaces:**
- Consumes: root script `wasm:build:web` (`package.json:24` — `wasm-pack build crates/wickedways-wasm --target bundler --out-dir pkg-web`).
- Produces: `packages/play` script `pretest:e2e`, auto-run by pnpm immediately before `test:e2e`.

- [ ] **Step 1: Confirm the browser wasm build works and emits `pkg-web`**

Run (from repo root):

```bash
pnpm -w run wasm:build:web
```

Expected (tail): a wasm-pack success banner, e.g.

```
[INFO]: ✨   Done in <N>s
[INFO]: 📦   Your wasm pkg is ready to publish at .../crates/wickedways-wasm/pkg-web.
```

Then verify the artifacts exist:

```bash
ls crates/wickedways-wasm/pkg-web
```

Expected to include: `wickedways_wasm.js`, `wickedways_wasm_bg.js`, `wickedways_wasm_bg.wasm`, `wickedways_wasm.d.ts`, `package.json`.

- [ ] **Step 2: Add the `pretest:e2e` wiring**

Edit `packages/play/package.json` `scripts` so it reads exactly:

```json
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "vite",
    "pretest:e2e": "pnpm -w run wasm:build:web",
    "test:e2e": "playwright test"
  },
```

(`pnpm -w run …` executes the script in the workspace-root package `wickedways`, whose `wasm:build:web` uses the repo-root-relative path `crates/wickedways-wasm`.)

- [ ] **Step 3: Verify the pre-script runs on its own**

Run:

```bash
pnpm --filter @wickedways/play run pretest:e2e
```

Expected: the same wasm-pack success banner as Step 1 (the `pkg-web` directory is rebuilt). This confirms pnpm resolves the workspace-root `-w` target from inside the `packages/play` filter.

- [ ] **Step 4: Confirm typecheck is unaffected**

Run:

```bash
pnpm --filter @wickedways/play run typecheck
```

Expected: no output, exit code 0 (adding a script does not affect `tsc`).

- [ ] **Step 5: Commit**

```bash
git add packages/play/package.json
git commit -m "build(play): build fresh pkg-web before e2e (pretest:e2e)"
```

---

### Task 2: WASM-boot smoke spec

Add a small, purpose-built spec whose only job is to fail loudly if the async-init → sync-`Authority` boot path breaks in a real browser. It installs `pageerror`/`console` listeners *before* navigation and asserts (a) the first room ("Foyer") renders — proof `initEngine()` resolved and `GameSession.start` constructed the `Authority` — and (b) no captured error matches `/engine not initialized|wasm|WebAssembly/i` (the exact throw text lives in `engine-web.ts:21`: `"engine not initialized: await initEngine() before GameSession.start"`). Two tests cover both entry paths: the deep-link `?campaign=…&surface=…` path and the full menu → surface-picker → surface path. Selectors are copied verbatim from the existing `playthrough.spec.ts`.

**Files:**
- Create: `packages/play/e2e/wasm-boot.spec.ts`

**Interfaces:**
- Consumes: the Vite dev server (baseURL `http://localhost:5174`) started by `playwright.config.ts` `webServer`; DOM selectors `#cmd`, `#transcript`, `surface-picker`, `.surface-entry`, and the accessible button name `"Enter Hollow House"` (all already used in `playthrough.spec.ts`).
- Produces: two Playwright tests in the `chromium` project; no exported helpers.

- [ ] **Step 1: Write the smoke spec**

Create `packages/play/e2e/wasm-boot.spec.ts` with exactly:

```ts
import { test, expect, type Page } from "@playwright/test";

// ── WASM boot smoke ──────────────────────────────────────────────────────────
//
// Runtime proof that the browser bundler path boots through the WASM Authority:
// bootLauncher awaits initEngine() once (async), then GameSession.start constructs
// the Authority synchronously. If that path breaks we see the engine-web.ts throw
// ("engine not initialized: await initEngine() before GameSession.start") or a
// wasm/WebAssembly load error in the console — this spec fails on any of those.

const WASM_ERROR = /engine not initialized|wasm|WebAssembly/i;

/** Attach page-error + console-error capture BEFORE any navigation. */
function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

test.describe("WASM Authority browser boot", () => {
  test("deep-link boot renders the first room with no wasm errors (CRT)", async ({ page }) => {
    const errors = captureErrors(page);

    // Deep-link straight to the CRT surface (bypasses menu + picker).
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");
    await page.getByRole("button", { name: "Enter Hollow House" }).click();

    // #cmd visible + "Foyer" in the transcript => initEngine() resolved and the
    // Authority booted the campaign synchronously (the room projected a ViewModel).
    await expect(page.locator("#cmd")).toBeVisible();
    await expect(page.locator("#transcript")).toContainText("Foyer");

    const wasmErrors = errors.filter((e) => WASM_ERROR.test(e));
    expect(wasmErrors, `unexpected WASM boot errors:\n${errors.join("\n")}`).toHaveLength(0);
  });

  test("menu → picker → CRT boot renders the first room with no wasm errors", async ({ page }) => {
    const errors = captureErrors(page);

    await page.goto("/");
    // Launcher menu → pick Hollow House (offers 2 surfaces → surface picker).
    await page.getByRole("button", { name: /Hollow House/ }).click();
    await expect(page.locator("surface-picker")).toBeVisible();
    // Pick CRT Terminal, then enter the game.
    await page.locator(".surface-entry", { hasText: "CRT Terminal" }).click();
    await page.getByRole("button", { name: "Enter Hollow House" }).click();

    await expect(page.locator("#transcript")).toContainText("Foyer");

    const wasmErrors = errors.filter((e) => WASM_ERROR.test(e));
    expect(wasmErrors, `unexpected WASM boot errors:\n${errors.join("\n")}`).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Ensure the chromium browser binary is installed (one-time per machine/CI)**

Run:

```bash
pnpm --filter @wickedways/play exec playwright install chromium
```

Expected: chromium downloads, or "is already installed" if present.

- [ ] **Step 3: Run ONLY the smoke spec to verify it passes**

Run (from repo root):

```bash
pnpm --filter @wickedways/play exec playwright test wasm-boot
```

Expected:

```
Running 2 tests using 1 worker
  2 passed (<N>s)
```

(`pretest:e2e` is NOT triggered by `playwright test` directly, so make sure `pkg-web` exists from Task 1; if unsure, run `pnpm -w run wasm:build:web` first. Playwright's `webServer` auto-starts `pnpm dev` on 5174.)

**Fallback (no chromium here):** If chromium cannot launch in this sandbox (Playwright errors with `browserType.launch: … Host system is missing dependencies` or `Executable doesn't exist`), do NOT treat that as a spec failure. Instead build-verify the app compiles the wasm path, then defer the run to CI (Task 3's `e2e.yml`):

```bash
pnpm --filter @wickedways/play run build
```

Expected: Vite build succeeds and emits a `.wasm` asset in the output (a line like `dist/assets/wickedways_wasm_bg-<hash>.wasm  <size> kB`). Note in the task record: "smoke spec authored; chromium unavailable in sandbox → CI-verified via e2e.yml."

- [ ] **Step 4: Commit**

```bash
git add packages/play/e2e/wasm-boot.spec.ts
git commit -m "test(e2e): WASM Authority browser-boot smoke spec"
```

---

### Task 3: Run the full existing playthrough against the cutover build, wire CI, and flip the README

Run the entire existing e2e suite (which now executes on the WASM `Authority` via the Vite/`pkg-web` path). If it is green, the runtime gap is closed. If any test fails *because of a WASM-boundary change* (e.g. a `ViewModel` field renamed/reshaped, or async-init timing), fix the **spec** — never the engine (engine changes go through the differential conformance gate). Then add a dedicated CI job so the browser e2e is exercised on every PR, and update the README's Phase-2 note.

**Files:**
- Modify: `package.json` (repo root) `scripts` block (`package.json:10-35`)
- Create: `.github/workflows/e2e.yml`
- Modify: `README.md:1872-1879` (Phase-2 "Scope / known gaps")
- Modify (conditional): `packages/play/e2e/playthrough.spec.ts` — only if a WASM-boundary failure is found

**Interfaces:**
- Consumes: `packages/play` scripts `pretest:e2e` + `test:e2e` (Task 1); the `wasm-boot.spec.ts` (Task 2).
- Produces: root script `test:e2e`; CI workflow `e2e`.

- [ ] **Step 1: Run the full e2e suite against the cutover build**

Run (from repo root):

```bash
pnpm --filter @wickedways/play run test:e2e
```

(`pretest:e2e` runs first → fresh `pkg-web`; then Playwright starts `pnpm dev` and runs every spec in `packages/play/e2e/`.)

Expected:

```
Running 22 tests using 1 worker
  22 passed (<N>s)
```

(20 pre-existing tests in `playthrough.spec.ts` + 2 from `wasm-boot.spec.ts`. Exact count may differ if the suite changed; what matters is **all passed**.)

**Fallback (no chromium here):** If chromium cannot launch in this sandbox, skip the local run and rely on the CI job added in Steps 4–5. Record: "full suite deferred to CI (e2e.yml)." Do NOT proceed to Step 6 (README flip) until the suite has been observed green — locally or in CI.

- [ ] **Step 2 (conditional): If a test failed due to a WASM-boundary change, debug it with systematic-debugging and fix the SPEC**

REQUIRED SUB-SKILL for this step: use superpowers:systematic-debugging.

Decision procedure — do NOT edit engine/Rust/`session.ts` to make a browser test pass:

1. Reproduce the single failing test in headed mode to see it:
   ```bash
   pnpm --filter @wickedways/play exec playwright test -g "<failing test name>" --headed
   ```
2. Classify the failure:
   - **A. WASM boundary / ViewModel shape** — a selector matched pre-cutover text/DOM that the Rust `ViewModel` projection now words or structures differently (e.g. a room name, HUD noun, status label, or exit text). Fix: update the selector/assertion in `packages/play/e2e/playthrough.spec.ts` to match the ViewModel the engine now emits. Confirm the engine's output is the intended contract by checking `crates/wickedways-core` projection / `generated/bindings/` — the engine is authoritative.
   - **B. Async-init timing** — a boot assertion races the one-time `await initEngine()`. Fix: in the spec, wait on a post-boot signal already used elsewhere (`await expect(page.locator("#cmd")).toBeVisible()` for CRT; `await expect(page.locator(".hotspot").first()).toBeVisible({ timeout: 10_000 })` for PnC) before asserting content. Do NOT make `GameSession.start` async.
   - **C. Genuine app bug in the surface/launcher (TS side)** — if a surface or `bootLauncher` mishandles the ViewModel, that is a TS fix in `packages/play*`, not the engine, and is out of scope for this verification plan: STOP and report it as a found defect rather than papering over it in the spec.
3. Re-run the single test until green, then re-run Step 1's full suite.
4. In the commit message, state exactly what the WASM boundary changed and which selector/assertion was updated.

If Step 1 was green, skip this step entirely.

- [ ] **Step 3: Add the root `test:e2e` convenience script**

Edit the repo-root `package.json` `scripts` block — add this one line (place it right after the `"test"` entry, keep all other scripts unchanged):

```json
    "test:e2e": "pnpm --filter @wickedways/play run test:e2e",
```

Do NOT add `test:e2e` to `checks`, `checks:phase2`, or any other aggregate gate — the browser e2e needs a Rust toolchain, wasm-pack, and a chromium binary that the fast `pnpm run checks` gate deliberately omits.

- [ ] **Step 4: Create the dedicated CI job**

Create `.github/workflows/e2e.yml` with exactly:

```yaml
name: E2E

# Browser end-to-end run: boots hollow-house through the WASM Authority in real
# chromium. Kept separate from the fast `checks` gate because it needs a Rust
# toolchain, wasm-pack, and a browser binary.
on:
  pull_request:
  workflow_dispatch:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: jetli/wasm-pack-action@v0.4.0
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.6
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @wickedways/play exec playwright install --with-deps chromium
      # `pretest:e2e` builds pkg-web (needs cargo + wasm-pack, both set up above);
      # then Playwright starts `pnpm dev` and runs every spec.
      - run: pnpm --filter @wickedways/play run test:e2e
        env:
          CI: "true"
```

- [ ] **Step 5: Validate the workflow YAML parses**

Run:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/e2e.yml')); print('e2e.yml OK')"
```

Expected:

```
e2e.yml OK
```

- [ ] **Step 6: Flip the README Phase-2 note to runtime-verified**

Only after the full suite is observed green (Step 1 locally, or the `e2e` CI job). In `README.md`, replace the "Scope / known gaps" sentence about the browser path. Change:

```
Two carries remain open: the browser bundler path is
**build-verified only** — the Playwright e2e boots hollow-house through the WASM `Authority`
but is a tracked follow-up, not yet exercised at runtime in this gate — and item `onUse`
```

to:

```
One carry remains open: the browser bundler path is now **runtime-verified** — the Playwright
e2e (`packages/play/e2e/`, run via `pnpm --filter @wickedways/play run test:e2e` and the
dedicated `.github/workflows/e2e.yml` CI job) boots hollow-house through the WASM `Authority`
in real chromium, and a `wasm-boot.spec.ts` smoke test asserts no `engine not initialized` /
wasm-load errors during boot. The remaining gap is item `onUse`
```

(This keeps the following clause — "consumable effects (e.g. laudanum restoring sanity) are **not yet ported** …" — intact, and downgrades "Two carries" → "One carry".)

- [ ] **Step 7: Confirm the doc/config change didn't break the fast gate**

Run:

```bash
pnpm run checks
```

Expected: lint + typecheck (root and per-package) + the full vitest suite all pass, exit code 0. (This does NOT run the browser e2e — by design.)

- [ ] **Step 8: Commit**

```bash
git add package.json .github/workflows/e2e.yml README.md
# include the next line only if Step 2 modified the spec:
git add packages/play/e2e/playthrough.spec.ts
git commit -m "test(e2e): run browser playthrough on WASM Authority + CI job; README runtime-verified"
```

---

## Self-Review

Checked against the spec with fresh eyes:

- **Spec coverage.** Task 1 = "wasm:build:web is a prerequisite of the e2e run" (`pretest:e2e`). Task 2 = "focused WASM-boot smoke spec: no `/engine not initialized|wasm|WebAssembly/i` error + first room renders" (`wasm-boot.spec.ts`, both entry paths). Task 3 = "run full existing playthrough; fix spec not engine if the WASM boundary changed; wire `test:e2e` into a gate/CI step; update README build-verified → runtime-verified." All Global Constraints from the task are copied verbatim. No gaps.
- **Placeholder scan.** No TBD/TODO; every code and command step shows real content — real Playwright APIs (`page.getByRole`, `page.locator`, `expect().toContainText`), real selectors lifted from `playthrough.spec.ts` (`#cmd`, `#transcript`, `surface-picker`, `.surface-entry`, button name "Enter Hollow House"), the real error string from `engine-web.ts:21`, and real commands with expected output. Task 3 Step 2 is conditional but gives a concrete decision tree, not "handle edge cases."
- **Type/name consistency.** Script names align across tasks: `pretest:e2e` (Task 1) is auto-run before `test:e2e`; root `test:e2e` (Task 3) delegates to `@wickedways/play run test:e2e`; `e2e.yml` invokes the same. The smoke regex `WASM_ERROR` is defined once and reused. `pnpm -w run wasm:build:web` matches the real root script at `package.json:24`.
- **Env caveat honored.** Every chromium-dependent step (Task 2 Step 3, Task 3 Step 1) carries a "Fallback (no chromium here)" note routing verification to CI; the README flip (Task 3 Step 6) is explicitly gated on observing the suite green locally OR in CI.
