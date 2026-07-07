import { test, expect, type Page } from "@playwright/test";

// ── WASM boot smoke ──────────────────────────────────────────────────────────
//
// Runtime proof that the browser bundler path boots through the WASM Authority:
// bootLauncher awaits initEngine() once (async), then GameSession.start constructs
// the Authority synchronously. If that path breaks we see the engine-web.ts throw
// ("engine not initialized: await initEngine() before GameSession.start") or a
// wasm/WebAssembly load error in the console — this spec fails on any of those.
//
// NOTE: the WASM_ERROR regex below only catches engine-init / wasm-load failures.
// The other boot-fatal class — a validate_mechanics rejection such as
// "Mechanic 'dread' is not registered." (a manifest that fails to thread its
// scripted behaviors) — is NOT matched by this regex; it is caught by the
// positive first-room render assertion (`toContainText(...)`), because a rejected
// boot never projects a room. Do not broaden this regex assuming it covers
// registration failures — the render assertion is the guard for those.

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
