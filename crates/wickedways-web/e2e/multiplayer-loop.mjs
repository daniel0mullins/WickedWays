// Browser e2e for the multiplayer loop (Phase 2c, sub-project D — slice 1).
//
// Drives the bundled Dioxus client in a real browser against a live `wickedways-server`: waits for
// the WebSocket handshake ("status: connected"), clicks the GM's `nextPlayer`, and asserts the head
// advances to 1 — i.e. browser → web-sys socket → axum → SyncAuthority commit → delta → mirror →
// SyncCoordinator all wired end-to-end. `run.sh` builds + serves + starts the server around this.
//
// Config via env: APP_URL (required), PW_CHROME (optional Playwright executablePath — set it when the
// environment's bundled browser build differs from Playwright's expected one, as in CI images).
//
// Not wired into CI here: it needs the wasm bundle + a running server + a browser, which the current
// CI jobs don't set up. Slice 5 re-points the repo's Playwright harness at this app.

import pw from "playwright";

const appUrl = process.env.APP_URL;
if (!appUrl) {
  console.error("set APP_URL");
  process.exit(2);
}

const browser = await pw.chromium.launch({
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log("  [browser]", m.text()));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(appUrl, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.innerText.includes("status: connected"), { timeout: 20000 });
  console.log("connected |", (await page.locator(".transcript").innerText()).replace(/\n/g, " | "));

  await page.click("#submit");
  await page.waitForFunction(() => document.body.innerText.includes("head: 1"), { timeout: 20000 });
  console.log("committed |", (await page.locator(".transcript").innerText()).replace(/\n/g, " | "));

  console.log("E2E_PASS");
} catch (e) {
  console.log("E2E_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
