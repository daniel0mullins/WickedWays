import { test, expect, type Page } from "@playwright/test";

// ── Shared helpers ──────────────────────────────────────────────────────────────

/**
 * Click the "Enter Hollow House" button and wait for the CRT command input to appear.
 * Callers must have already navigated to the CRT surface (e.g. via ?surface=crt-terminal).
 */
async function enterGame(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Enter Hollow House" }).click();
  await expect(page.locator("#cmd")).toBeVisible();
}

/**
 * Navigate to the PnC surface via the surface picker and click "Enter Hollow House" on the
 * PnC welcome screen. Waits until `pnc-scene` has at least one hotspot visible, confirming
 * the game is live and the first room has rendered.
 */
async function enterPncGame(page: Page): Promise<void> {
  // The PnC welcome screen has a button rendered inside pnc-welcome shadow DOM.
  // Playwright pierces open shadow roots automatically, so getByRole works here.
  await page.getByRole("button", { name: "Enter Hollow House" }).click();
  // Wait for at least one scene hotspot (the opening Foyer has north/south exits + foyer-table).
  await expect(page.locator(".hotspot").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Navigate through an exit hotspot by clicking it. The PnC controller fires a
 * lone move-intent immediately — no action menu appears for exit hotspots.
 * We verify the navigation happened by waiting for the topbar room name to change.
 */
async function goDirection(page: Page, dir: string): Promise<void> {
  // Capture the current room name displayed in the topbar.
  const roomNameEl = page.locator(".room-name");
  const before = (await roomNameEl.textContent()) ?? "";
  // Real coordinate-based click — exercises the layout's actual hit-testing.
  await page.locator(`.hotspot[data-key="${dir}"]`).click();
  // Wait for the topbar room name to update (confirms the move intent completed).
  await expect(roomNameEl).not.toHaveText(before, { timeout: 5_000 });
}


/**
 * Click a body hotspot (loot, item, or occupant) by matching text visible in its label,
 * then pick the given verb from the action menu. Body hotspot keys are generated IDs,
 * so text matching is the only reliable way to locate them.
 */
async function clickBodyHotspot(
  page: Page,
  kind: "loot" | "item" | "occupant",
  textMatch: string | RegExp,
  verb: string,
): Promise<void> {
  const hs = page.locator(`.hotspot.${kind}`, { hasText: textMatch });
  await expect(hs).toBeVisible({ timeout: 5_000 });
  // Real coordinate-based click — proves the layout gives hotspots real hit areas.
  await hs.click();
  const menuBtn = page.locator("pnc-action-menu button", { hasText: verb });
  await expect(menuBtn).toBeVisible({ timeout: 5_000 });
  await menuBtn.click();
  await expect(page.locator("pnc-action-menu")).not.toBeVisible({ timeout: 5_000 });
}

/**
 * Click an inventory entry by its visible label text, then click a verb in the action menu.
 */
async function clickInventoryVerb(page: Page, itemName: string, verb: string): Promise<void> {
  const entry = page.locator("pnc-inventory .inventory-entry", { hasText: itemName });
  await expect(entry).toBeVisible({ timeout: 5_000 });
  // Real coordinate-based click — the sidebar has real layout dimensions.
  await entry.click();
  const menuBtn = page.locator("pnc-action-menu button", { hasText: verb });
  await expect(menuBtn).toBeVisible({ timeout: 5_000 });
  await menuBtn.click();
  await expect(page.locator("pnc-action-menu")).not.toBeVisible({ timeout: 5_000 });
}

// ── Winning command sequence (CRT surface) ──────────────────────────────────────

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

// ── CRT surface tests ───────────────────────────────────────────────────────────

test.describe("Wicked Ways browser playthrough", () => {
  test("plays the haunted house to a win", async ({ page }) => {
    test.setTimeout(120_000);

    // Deep-link directly to the CRT surface to bypass the surface picker.
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");
    await enterGame(page);

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
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");
    await enterGame(page);

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
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");
    await enterGame(page);

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

  test("welcome screen shows title and enter button; game starts after clicking", async ({ page }) => {
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");

    // Before entering: welcome content is visible, game input is not.
    await expect(page.locator(".welcome-title")).toContainText("The Hollow House");
    await expect(page.getByRole("button", { name: "Enter Hollow House" })).toBeVisible();
    await expect(page.locator("#cmd")).not.toBeVisible();

    // After clicking enter: game input is visible and first room (Foyer) is rendered.
    await enterGame(page);
    await expect(page.locator("#transcript")).toContainText("Foyer");
    await expect(page.locator("#cmd")).toBeVisible();
  });

  test("campaign menu lists entries, enters one, and returns", async ({ page }) => {
    await page.goto("/");

    // Both campaigns must be listed in the menu.
    await expect(page.getByText("The Hollow House")).toBeVisible();
    await expect(page.getByText("Seed Demo")).toBeVisible();

    // Clicking the Hollow House entry launches the surface picker (Hollow House has 2 surfaces).
    await page.getByRole("button", { name: /Hollow House/ }).click();
    await expect(page.locator("surface-picker")).toBeVisible();

    // The picker must list both surfaces. CRT Terminal has no description, so its label
    // text appears twice (in .surface-label AND .surface-desc). Use .surface-label to
    // avoid a strict-mode multi-match on getByText("CRT Terminal").
    await expect(page.locator(".surface-label", { hasText: "CRT Terminal" })).toBeVisible();
    await expect(page.locator(".surface-label", { hasText: "Point & Click" })).toBeVisible();

    // Pick CRT Terminal — the CRT welcome screen should appear.
    // Click the .surface-entry button that contains "CRT Terminal" text (unique match).
    await page.locator(".surface-entry", { hasText: "CRT Terminal" }).click();
    await expect(page.getByRole("button", { name: /Enter Hollow House/ })).toBeVisible();

    // Back to menu — the bezel button navigates back.
    await page.getByRole("button", { name: /menu/i }).click();
    await expect(page.getByText("Seed Demo")).toBeVisible();
  });

  test("seed campaign boots without error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");

    // Click the Seed Demo entry in the launcher menu.
    await page.getByRole("button", { name: /Seed Demo/ }).click();

    // The seed welcome screen appears with its enter button.
    await expect(page.getByRole("button", { name: /Enter Demo/ })).toBeVisible();

    // No uncaught page errors or console errors during seed boot.
    expect(errors).toHaveLength(0);
  });

  test("haunted theme persists across page reload via ?theme= param", async ({ page }) => {
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");
    await page.getByRole("button", { name: /Enter Hollow House/ }).click();
    await expect(page.locator("#cmd")).toBeVisible();

    // Switch to haunted theme via the bezel combobox.
    await page.getByRole("combobox", { name: /theme/i }).selectOption("haunted");

    // URL must immediately reflect the new theme (replaceState is synchronous).
    await expect(page).toHaveURL(/theme=haunted/);

    // Haunted palette bg (#080406) must be applied to the CRT housing element.
    const housing = page.locator("[data-crt-housing]");
    const bgBeforeReload = await housing.evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--crt-bg").trim(),
    );
    expect(bgBeforeReload).toBe("#080406");

    // Reload — the ?theme=haunted param must survive and be re-applied on boot.
    await page.reload();
    // Wait for the app to have re-booted (welcome screen re-appears).
    await expect(page.getByRole("button", { name: /Enter Hollow House/ })).toBeVisible();

    // URL still carries ?theme=haunted after reload.
    expect(page.url()).toContain("theme=haunted");

    // Haunted theme must still be applied on the housing after reload.
    const bgAfterReload = await housing.evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--crt-bg").trim(),
    );
    expect(bgAfterReload).toBe("#080406");
  });

  test("theme switcher reskins the CRT", async ({ page }) => {
    await page.goto("/?campaign=hollow-house&surface=crt-terminal");
    await page.getByRole("button", { name: /Enter Hollow House/ }).click();
    await expect(page.locator("#cmd")).toBeVisible();

    // Read the current foreground colour from the CRT housing element
    // (applyTheme sets --crt-fg on the root element).
    const housing = page.locator("[data-crt-housing]");
    const before = await housing.evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--crt-fg"),
    );

    // Switch to the haunted theme via the bezel combobox.
    await expect(page.getByRole("combobox", { name: /theme/i })).toBeVisible();
    await page.getByRole("combobox", { name: /theme/i }).selectOption("haunted");

    const after = await housing.evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--crt-fg"),
    );

    // The foreground colour must have changed.
    expect(after).not.toBe(before);
  });

  // ── Point-and-click surface tests ─────────────────────────────────────────────

  test("surface picker lists both surfaces; picking Point & Click mounts the PnC scene", async ({ page }) => {
    // ?campaign=hollow-house has two surfaces → shows the surface picker.
    await page.goto("/?campaign=hollow-house");

    // The surface picker must list both options. CRT Terminal has no description so
    // its label appears in both .surface-label and .surface-desc — use .surface-label
    // selectors to avoid a strict-mode multi-match.
    const picker = page.locator("surface-picker");
    await expect(picker).toBeVisible();
    await expect(page.locator(".surface-label", { hasText: "CRT Terminal" })).toBeVisible();
    await expect(page.locator(".surface-label", { hasText: "Point & Click" })).toBeVisible();

    // Click "Point & Click" — launcher must set ?surface=point-and-click in the URL.
    await page.locator(".surface-entry", { hasText: "Point & Click" }).click();
    await expect(page).toHaveURL(/surface=point-and-click/);

    // The PnC welcome screen mounts (pnc-welcome component rendered).
    await expect(page.getByRole("button", { name: "Enter Hollow House" })).toBeVisible();

    // Enter the game — the scene hotspots must appear.
    await enterPncGame(page);
    // At least one hotspot must be present in the Foyer (north/south exits + foyer-table loot).
    await expect(page.locator(".hotspot").first()).toBeVisible();
  });

  /**
   * Win Hollow House by clicking only — uses hotspots, inventory entries, and action-menu verbs.
   *
   * Loot container hotspot keys are generated IDs (not the template builder key like
   * "foyer-table"), so loot and item hotspots are located by their visible label text using
   * `.hotspot.loot` / `.hotspot.item` with `{ hasText }` rather than `data-key`.
   * Exit hotspots use stable direction strings as keys and are clicked via `clickHotspotVerb`.
   *
   * Combat: Revenant has Health=10, Sanity=8. Player equips Iron Fire-Poker (modifier=5).
   * Damage per hit = 5 × (10−8) × 0.2 = 2. Five hits → 10 damage → KO. The PnC affordances
   * remove the "Attack" verb once the occupant is defeated, so exactly 5 attacks are used
   * (unlike the CRT test which uses 6 because the engine silently no-ops on a KO'd mob).
   */
  test("wins Hollow House by clicking (PnC surface)", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/?campaign=hollow-house&surface=point-and-click");
    await enterPncGame(page);

    // ── Foyer: open chest (foyer-table), take journal ────────────────────────────
    // Loot containers are identified by their description text.
    // "foyer-table" description: "A hall table with a single drawer."
    await clickBodyHotspot(page, "loot", /drawer/i, "Open");

    // After opening, "Water-Stained Journal" appears as a floor-item hotspot.
    await clickBodyHotspot(page, "item", /Journal/i, "Take");

    // ── Hall: go north, open stand (hall-stand), take + equip poker ──────────────
    await goDirection(page, "north");  // Foyer → Hall

    // "hall-stand" description: "A fireplace stand."
    await clickBodyHotspot(page, "loot", /fireplace stand/i, "Open");
    await clickBodyHotspot(page, "item", /Poker/i, "Take");

    // Poker is now in inventory — click it → Equip.
    await clickInventoryVerb(page, "Poker", "Equip");

    // ── Kitchen: go west, open hook (kitchen-hook), take + equip lantern ─────────
    await goDirection(page, "west");  // Hall → Kitchen

    // "kitchen-hook" description: "A lantern hangs from a hook."
    await clickBodyHotspot(page, "loot", /hangs from a hook/i, "Open");
    await clickBodyHotspot(page, "item", /Lantern/i, "Take");

    // Lantern is now in inventory — Equip it.
    await clickInventoryVerb(page, "Lantern", "Equip");

    // ── Navigate: Kitchen → Hall → Landing → Hall → Foyer → Cellar ──────────────
    await goDirection(page, "east");   // Kitchen → Hall
    await goDirection(page, "north");  // Hall → Landing
    await goDirection(page, "south");  // Landing → Hall
    await goDirection(page, "south");  // Hall → Foyer
    await goDirection(page, "south");  // Foyer → Cellar

    // ── Cellar: attack Revenant ×5 (exact: 5 hits × 2 dmg = 10 HP = KO) ─────────
    for (let i = 0; i < 5; i++) {
      await clickBodyHotspot(page, "occupant", "Revenant", "Attack");
    }

    // After KO, the Revenant's remains loot container appears. Open it, then take the key.
    await clickBodyHotspot(page, "loot", /remains/i, "Open");
    await clickBodyHotspot(page, "item", /Iron Key/i, "Take");

    // ── Navigate to Landing: Cellar → Foyer → Hall → Landing ────────────────────
    await goDirection(page, "north");  // Cellar → Foyer
    await goDirection(page, "north");  // Foyer → Hall
    await goDirection(page, "north");  // Hall → Landing

    // ── Enter the Attic (iron key unlocks the north door → WIN) ──────────────────
    // With the Iron Key in inventory, the north exit in Landing is now passable.
    await goDirection(page, "north");  // Landing → Attic

    // Assert win narration in pnc-log.
    await expect(page.locator("pnc-log")).toContainText(
      "You climb into the attic with the journal in hand",
      { timeout: 30_000 },
    );
    await expect(page.locator("pnc-log")).toContainText("— THE END —");
  });

  test("PnC transcript text is legible (not black-on-black)", async ({ page }) => {
    // Regression: the opening room name + description print into pnc-log, but a
    // missing foreground color let the `.line` text inherit the UA default
    // (black) against the dark PnC background — present in the DOM (so
    // toContainText passed) yet invisible to the player.
    await page.goto("/?campaign=hollow-house&surface=point-and-click");
    await enterPncGame(page);

    // The first transcript line is the Foyer room name.
    const firstLine = page.locator("pnc-log .line").first();
    await expect(firstLine).toHaveText("Foyer");

    // It must render in the theme ink (cream), not black — i.e. legible.
    const color = await firstLine.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(232, 226, 208)");
  });

  test("PnC text is sans-serif and 50% larger than the root size", async ({ page }) => {
    await page.goto("/?campaign=hollow-house&surface=point-and-click");
    await enterPncGame(page);

    const m = await page.locator("pnc-log .line").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        family: cs.fontFamily.toLowerCase(),
        size: parseFloat(cs.fontSize),
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    });
    // Sans-serif stack, not the old serif (Georgia/Palatino) one.
    expect(m.family).toContain("sans-serif");
    expect(m.family).not.toContain("georgia");
    expect(m.family).not.toContain("serif,"); // a serif stack would read "…, serif"
    // 50% larger than the document root font size.
    expect(m.size).toBeCloseTo(m.root * 1.5, 1);
  });

  test("PnC transcript room headings are bold and underlined", async ({ page }) => {
    await page.goto("/?campaign=hollow-house&surface=point-and-click");
    await enterPncGame(page);

    const heading = page.locator("pnc-log .line.heading").first();
    await expect(heading).toHaveText("Foyer");
    const style = await heading.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { weight: cs.fontWeight, decoration: cs.textDecorationLine };
    });
    expect(Number(style.weight)).toBeGreaterThanOrEqual(700);
    expect(style.decoration).toContain("underline");
  });

  test("PnC surface holds a centered 16:9 box on an off-ratio (tall) window", async ({ page }) => {
    // A very tall window must not stretch the surface; it letterboxes to 16:9.
    await page.setViewportSize({ width: 900, height: 1400 });
    await page.goto("/?campaign=hollow-house&surface=point-and-click");
    await enterPncGame(page);

    const box = await page.locator("[data-pnc-app]").boundingBox();
    expect(box).not.toBeNull();
    // 16:9 aspect (within rounding tolerance).
    expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
    // Width-limited on a tall window: full width, height capped well under 1400.
    expect(Math.round(box!.width)).toBe(900);
    expect(box!.height).toBeLessThan(1400);
    // Centered: roughly equal dark bars top and bottom.
    const bottomGap = 1400 - (box!.y + box!.height);
    expect(Math.abs(box!.y - bottomGap)).toBeLessThan(2);
  });

  test("PnC deep-link with ?theme=haunted applies haunted theme and persists across reload", async ({ page }) => {
    // Deep-link directly into PnC with haunted theme.
    await page.goto("/?campaign=hollow-house&surface=point-and-click&theme=haunted");

    // PnC welcome screen mounts.
    await expect(page.getByRole("button", { name: "Enter Hollow House" })).toBeVisible();

    // The haunted PnC theme sets --pnc-bg to #070508 on the pnc-app element.
    const app = page.locator("[data-pnc-app]");
    const bgBefore = await app.evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--pnc-bg").trim(),
    );
    expect(bgBefore).toBe("#070508");

    // Reload — ?theme=haunted must survive and re-apply.
    await page.reload();
    await expect(page.getByRole("button", { name: "Enter Hollow House" })).toBeVisible();
    expect(page.url()).toContain("theme=haunted");

    const bgAfter = await app.evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--pnc-bg").trim(),
    );
    expect(bgAfter).toBe("#070508");
  });

  test("PnC back-to-menu returns to the campaign menu", async ({ page }) => {
    await page.goto("/?campaign=hollow-house&surface=point-and-click");
    await enterPncGame(page);

    // The topbar "Back to menu" button (class "topbar-btn-menu") opens the pnc-menu overlay.
    // pnc-menu uses a backdrop @click handler (not a window listener) so the opening
    // click does not self-dismiss the overlay. Real coordinate click works here.
    await page.locator(".topbar-btn-menu").click();

    // The pnc-menu overlay must be visible. pnc-menu is a LitElement with a shadow root
    // containing a `.menu-overlay` div. We locate that inner div instead of the host
    // element tag (more reliable with Playwright's shadow-DOM CSS piercing).
    const menuOverlay = page.locator(".menu-overlay");
    await expect(menuOverlay).toBeVisible({ timeout: 5_000 });

    // Click the "Back to menu" action button inside the overlay.
    await page.locator("button[data-action='exit']").click();

    // Should now be back on the campaign menu.
    await expect(page.getByText("Seed Demo")).toBeVisible();
    await expect(page.getByText("The Hollow House")).toBeVisible();
  });
});
