import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { bootLauncher } from "@wickedways/play-runtime";
import { LocalStorageSaveStore } from "@wickedways/play-runtime";
import { crtSurface } from "@wickedways/play-surface/crt";
import { pncSurface } from "@wickedways/play-surface/pnc";
import { SHIPPED_CAMPAIGNS } from "./campaigns.js";

const app = document.getElementById("app");
if (app) {
  // Test-only deterministic seed hook: e2e specs set `globalThis.__WICKED_SEED`
  // via Playwright's addInitScript so roving-encounter spawns are reproducible.
  // Undefined in production → GameSession draws a fresh random seed as usual.
  const testSeed = (globalThis as { __WICKED_SEED?: number }).__WICKED_SEED;
  await bootLauncher(app, { campaigns: SHIPPED_CAMPAIGNS, surfaces: [crtSurface, pncSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
    ...(testSeed !== undefined ? { seed: testSeed } : {}),
  });
}
