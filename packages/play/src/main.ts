import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { bootLauncher } from "./core/launcher.js";
import { LocalStorageSaveStore } from "./core/savestore.js";
import { hollowHouse } from "./campaign/manifest.js";
import { crtSurface } from "./text/surface.js";

const app = document.getElementById("app");
if (app) {
  bootLauncher(app, { campaigns: [hollowHouse], surfaces: [crtSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
}
