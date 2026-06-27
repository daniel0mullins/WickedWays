import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { bootLauncher } from "@wickedways/play-runtime";
import { LocalStorageSaveStore } from "@wickedways/play-runtime";
import { hollowHouse } from "./campaign/manifest.js";
import { crtSurface } from "@wickedways/play-surface-crt";

const app = document.getElementById("app");
if (app) {
  bootLauncher(app, { campaigns: [hollowHouse], surfaces: [crtSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
}
