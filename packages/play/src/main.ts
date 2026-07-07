import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { bootLauncher } from "@wickedways/play-runtime";
import { LocalStorageSaveStore } from "@wickedways/play-runtime";
import { crtSurface } from "@wickedways/play-surface/crt";
import { pncSurface } from "@wickedways/play-surface/pnc";
import { SHIPPED_CAMPAIGNS } from "./campaigns.js";

const app = document.getElementById("app");
if (app) {
  await bootLauncher(app, { campaigns: SHIPPED_CAMPAIGNS, surfaces: [crtSurface, pncSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
}
