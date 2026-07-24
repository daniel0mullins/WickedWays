// Browser e2e for multiplayer managed-turns (action budget + player-driven `endTurn`).
//
// Drives the bundled Dioxus client against a live `wickedways-server` whose room authority runs with
// `manage_turns: true`. The GM identity owns the active seat (Ada), so its End Turn button renders;
// clicking it submits `Command::EndTurn { actor_id }` for the active seat, which the server routes to
// that seat (membership `actorOf` → `Actor::Character`), authorizes, and applies as a turn advance:
// browser → web-sys socket → axum → SyncAuthority (endTurn → next_player → start_turn) → delta →
// mirror → SyncCoordinator → ViewModel. The active character flips Ada → Ben end-to-end, proving the
// player-end-turn button is wired through the managed-turns path. `run-managed.sh` builds + serves +
// starts the server around this.
//
// Config via env: APP_URL (required), PW_CHROME (optional Playwright executablePath). Not wired into
// CI: it needs the wasm bundle + a running server + a browser.

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
  // The `demo` campaign is `?debug`-gated and multiplayer opens in the lobby: click "Enter the game"
  // to leave the lobby for the live game view. (Allow a generous window for the cold wasm boot +
  // WebSocket handshake.)
  await page.waitForFunction(() => document.body.innerText.includes("Enter the game"), { timeout: 30000 });
  await page.locator('button:has-text("Enter the game")').click();
  // The room renders once the handshake seeded the replica and the ViewModel projected. Ada is the
  // active seat, so Ben is listed as the co-located occupant.
  await page.waitForFunction(() => document.body.innerText.includes("Start"), { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes("Ben"), { timeout: 20000 });

  // Managed-turns renders the player's own End Turn button while their seat is active. (The GM's
  // nextPlayer control stays available separately for an unavailable player.)
  await page.waitForSelector(".end-turn-btn", { timeout: 20000 });
  console.log("connected |", (await page.locator(".transcript").innerText()).replace(/\n/g, " | "));

  // Ending Ada's turn advances the active seat to Ben; his view now lists Ada as the occupant.
  await page.click(".end-turn-btn");
  await page.waitForFunction(() => document.body.innerText.includes("Ada"), { timeout: 20000 });
  console.log("ended turn |", (await page.locator(".transcript").innerText()).replace(/\n/g, " | "));

  console.log("E2E_PASS");
} catch (e) {
  console.log("E2E_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
