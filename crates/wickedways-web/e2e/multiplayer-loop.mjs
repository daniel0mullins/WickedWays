// Browser e2e for the multiplayer loop + game view (Phase 2c, sub-project D — slices 1-2).
//
// Drives the bundled Dioxus client in a real browser against a live `wickedways-server`: waits for
// the room ("Start") to render — proving the WebSocket handshake seeded the replica and the engine
// ViewModel projected — then clicks the GM's `nextPlayer` and asserts the active character flips
// (the "Here" occupant changes from Ben to Ada), i.e. browser → web-sys socket → axum →
// SyncAuthority commit → delta → mirror → SyncCoordinator → ViewModel, all wired end-to-end. `run.sh`
// builds + serves + starts the server around this.
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
  // The room renders once the handshake seeded the replica and the ViewModel projected. Ada is
  // active, so the "Here" occupant is Ben.
  await page.waitForFunction(() => document.body.innerText.includes("Start"), { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes("Ben"), { timeout: 20000 });
  console.log("connected |", (await page.locator(".transcript").innerText()).replace(/\n/g, " | "));

  // GM nextPlayer flips the active character to Ben; his view lists Ada as the occupant.
  await page.click("#submit");
  await page.waitForFunction(() => document.body.innerText.includes("Ada"), { timeout: 20000 });
  console.log("committed |", (await page.locator(".transcript").innerText()).replace(/\n/g, " | "));

  console.log("E2E_PASS");
} catch (e) {
  console.log("E2E_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
