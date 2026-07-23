// Single-player browser e2e (offline CRT surface, `?mode=single` — no server needed).
//
// Drives the bundled Dioxus client through the Hollow House single-player flow in a real browser,
// exercising the fixes that the multiplayer sync path had dropped: the caretaker's dialogue
// (`talk`), keyed doors gating movement, the solo turn loop (dread draining sanity on a passed
// turn), single-player `undo`, `fullscreen`, and the absence of the GM `nextPlayer` control. This is
// the single-player companion to `multiplayer-loop.mjs`; `run-single.sh` bundles + serves + drives it.
//
// Config via env: APP_URL (required) — the served client with
// `?campaign=hollow-house&surface=crt-terminal&mode=single`; PW_CHROME (optional Playwright
// executablePath, for images whose bundled browser build differs from Playwright's expected one).
//
// Not wired into CI: it needs the wasm bundle + a browser.

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

const ok = (cond, msg) => {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓", msg);
};

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  const type = async (cmd) => { await page.fill("#prompt", cmd); await page.press("#prompt", "Enter"); };
  const body = () => page.evaluate(() => document.body.innerText);
  const room = () => page.locator(".room-name").innerText();
  const san = async () => parseInt((await page.locator(".hud").innerText()).match(/SAN\s+(\d+)/)?.[1] ?? "-1", 10);
  const waitText = (s) => page.waitForFunction((t) => document.body.innerText.includes(t), s, { timeout: 15000 });
  const waitRoom = (name) => page.waitForFunction(
    (n) => document.querySelector(".room-name")?.textContent?.includes(n), name, { timeout: 15000 });

  await page.goto(appUrl, { waitUntil: "load" });

  // Welcome gate → Enter, then the Foyer game view renders.
  await page.waitForSelector(".enter-btn", { timeout: 20000 });
  await page.click(".enter-btn");
  await waitRoom("Foyer");
  console.log("booted:", await room());

  // 1. No GM:nextPlayer control in single-player (turn-passing is not a single-player concept).
  ok((await page.locator("#submit").count()) === 0, "single-player shows no GM:nextPlayer button");

  // 2. The caretaker is present in the Foyer.
  await waitText("Caretaker");
  ok((await body()).includes("Caretaker"), "the caretaker is in the Foyer");

  // 3. The cellar door (south) is locked before the key is in hand.
  await type("south");
  await waitText("won't budge");
  ok((await room()).includes("Foyer"), "the locked cellar door barred the move");

  // 4. Talking to the caretaker hands over the cellar key (the dialogue line renders).
  await type("talk caretaker");
  await waitText("cellar key");
  ok((await body()).includes("Take the cellar key"), "the caretaker's dialogue renders");

  // 5. With the key, the cellar door opens.
  await type("south");
  await waitRoom("Cellar");
  ok((await room()).includes("Cellar"), "moved into the Cellar with the key");

  // 6. Undo reverts back to the Foyer.
  await type("undo");
  await waitText("Undone");
  await waitRoom("Foyer");
  ok((await room()).includes("Foyer"), "undo reverted the move back to the Foyer");

  // 7. Dread drains sanity on a passed turn (the solo loop fired start_turn).
  const before = await san();
  await type("wait");
  await page.waitForFunction((b) => {
    const m = document.querySelector(".hud")?.textContent?.match(/SAN\s+(\d+)/);
    return m && parseInt(m[1], 10) < b;
  }, before, { timeout: 15000 });
  ok((await san()) < before, `dread drained sanity on wait (${before} -> ${await san()})`);

  // 8. The fullscreen verb is handled (headless may reject the request; the surface still reports it).
  await type("fullscreen");
  await waitText("Fullscreen");
  ok((await body()).includes("Fullscreen"), "the fullscreen verb is handled");

  console.log("E2E_PASS");
} catch (e) {
  console.log("E2E_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
