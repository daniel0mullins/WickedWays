// Browser e2e for the crafting loop (harvest -> craft) against the Covenant campaign.
//
// Drives the bundled client against a live `wickedways-server` seeded with the Covenant genesis +
// catalog (so the authority resolves the `ward-charm` recipe). The active Warden moves to the
// Crossing, harvests the Ward Slag into the shared pool, then forges the Ward Charm — proving the
// whole materials economy end to end: browser -> web-sys socket -> axum -> SyncAuthority
// (harvest/craft) -> delta -> mirror -> ViewModel (caches/materials/recipes) -> CRT render.
//
// Config via env: APP_URL (required), PW_CHROME (optional). Not wired into CI.

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

const body = (page) => page.evaluate(() => document.body.innerText);
// The Dioxus/wasm app drives its own render loop, so Playwright's default `raf`-polled
// waitForFunction can starve; poll the body text via evaluate instead.
const waitForText = async (page, test, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await body(page).catch(() => "");
    if (test(t)) return t;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const submit = async (page, line) => {
  const input = page.locator("#prompt");
  await input.fill(line);
  await input.press("Enter");
};

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(appUrl, { waitUntil: "load" });
  // The Covenant genesis is pre-begin, so the GM lobby offers "Start the campaign" (which
  // `BeginCampaign`s), not the "Enter the game" an already-started campaign shows.
  await waitForText(page, (t) => t.includes("Start the campaign"), "the GM lobby");
  await page.locator('button:has-text("Start the campaign")').click();
  // Starting flips the lobby to "Enter the game"; click that to leave the lobby for the live view.
  await waitForText(page, (t) => t.includes("Enter the game"), "the entered lobby");
  await page.locator('button:has-text("Enter the game")').click();
  // Antechamber is the start room; the Ward Slag cache lives one room north in the Crossing.
  await waitForText(page, (t) => t.includes("Antechamber"), "the start room");

  await submit(page, "north");
  await waitForText(page, (t) => t.includes("Ward Slag"), "the Ward Slag cache");
  console.log("at the Crossing, cache visible");

  // Harvest deposits iron+salt into the shared pool (shown in the MATERIALS readout).
  await submit(page, "harvest ward slag");
  await waitForText(page, (t) => /iron\s*×\s*3/.test(t), "the harvested materials");
  console.log("harvested |", (await body(page)).replace(/\n/g, " | ").slice(0, 240));

  // Forge the Ward Charm; it lands in inventory and the pool is debited (iron 3 -> 1).
  await submit(page, "craft ward charm");
  await waitForText(page, (t) => t.includes("Ward Charm") && /iron\s*×\s*1/.test(t), "the crafted charm");
  console.log("crafted |", (await body(page)).replace(/\n/g, " | ").slice(0, 240));

  // Regression: the crafted item and its recipe share a name. A physical verb must resolve the held
  // item without the parser reporting an ambiguity ("Which do you mean: Ward Charm, Ward Charm?").
  await submit(page, "equip ward charm");
  await waitForText(page, (t) => t.includes("› equip ward charm"), "the equip echo");
  await new Promise((r) => setTimeout(r, 1000));
  const after = await body(page);
  if (/Which do you mean/.test(after)) throw new Error("recipe/item name still ambiguous");
  console.log("no ambiguity on equip after craft");

  console.log("E2E_PASS");
} catch (e) {
  console.log("E2E_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
