import { test, expect } from "@playwright/test";

/**
 * Winning command sequence mirrored from capstone.test.ts.
 * Combat damage is deterministic regardless of Math.random() because the
 * damage formula uses only stats/modifiers (no rng), and baseEncounterChance=0
 * disables random encounters. 6 attacks defeat the Revenant (Health=10,
 * Sanity=8, poker modifier=5 → 2 damage/hit, 10÷2=5 kills, +1 buffer = 6).
 */
const WINNING_COMMANDS = [
  // 1. Foyer: get journal
  "open chest",
  "take journal",
  // 2. Hall: get + equip poker
  "n",
  "open chest",
  "take poker",
  "equip poker",
  // 3. Kitchen: get + equip lantern
  "w",
  "open chest",
  "take lantern",
  "equip lantern",
  // 4. Save, move east (to Hall), undo back to Kitchen
  "save",
  "e",
  "undo",
  // 5. Navigate to Landing to pass through, then back to Cellar
  "e",   // Kitchen → Hall
  "n",   // Hall → Landing
  "s",   // Landing → Hall
  "s",   // Hall → Foyer
  "s",   // Foyer → Cellar
  // 6. Defeat Revenant (6 attacks), loot iron key
  "attack revenant",
  "attack revenant",
  "attack revenant",
  "attack revenant",
  "attack revenant",
  "attack revenant",
  "open chest",
  "take key",
  // 7. Navigate to Landing
  "n",   // Cellar → Foyer
  "n",   // Foyer → Hall
  "n",   // Hall → Landing
  // 8. Walk north into attic (iron key unlocks → WIN)
  "n",
];

test.describe("Wicked Ways browser playthrough", () => {
  test("plays the haunted house to a win", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");

    // Opening room must be the Foyer.
    await expect(page.locator("#transcript")).toContainText("Foyer");

    // Drive the full winning command sequence.
    for (const cmd of WINNING_COMMANDS) {
      await page.fill("#cmd", cmd);
      await page.press("#cmd", "Enter");
    }

    // Assert win narration and THE END marker.
    await expect(page.locator("#transcript")).toContainText(
      "You climb into the attic with the journal in hand",
      { timeout: 30_000 },
    );
    await expect(page.locator("#transcript")).toContainText("— THE END —");
  });

  test("exit link fills the command line without submitting", async ({ page }) => {
    await page.goto("/");

    // The opening Foyer's bottom HUD lists passable exits as clickable text links.
    const firstExit = page.locator(".exit-link").first();
    await expect(firstExit).toBeVisible();

    await firstExit.click();

    // #cmd should now contain "go <dir>" …
    await expect(page.locator("#cmd")).toHaveValue(/^go /);
    // … and the value must still be present (form submit clears #cmd).
    const value = await page.locator("#cmd").inputValue();
    expect(value.trim().length).toBeGreaterThan(0);

    // No echo line should have been printed (no "> go …" in transcript yet).
    const transcriptText = await page.locator("#transcript").innerText();
    // The command was NOT submitted, so no "> go …" echo appears.
    expect(transcriptText).not.toMatch(/^> go /m);
  });

  test("clicking a noun fills 'examine <noun>' without submitting", async ({ page }) => {
    await page.goto("/");

    // The opening Foyer's bottom HUD shows "Here: A hall table with a single drawer."
    // "drawer" is an alias of the foyer-table loot container → rendered as a .noun span.
    // (Loot moved from the transcript to the persistent HUD, where nouns stay clickable.)
    const firstNoun = page.locator("#hud .noun").first();
    await expect(firstNoun).toBeVisible();

    await firstNoun.click();

    // #cmd should now read "examine <noun>" …
    await expect(page.locator("#cmd")).toHaveValue(/^examine /);
    // … and must still hold the value (submit would clear it).
    const value = await page.locator("#cmd").inputValue();
    expect(value.trim().length).toBeGreaterThan(0);

    // No echo line for the examine command (not submitted).
    const transcriptText = await page.locator("#transcript").innerText();
    expect(transcriptText).not.toMatch(/^> examine /m);
  });
});
