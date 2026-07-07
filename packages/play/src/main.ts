import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { bootLauncher } from "@wickedways/play-runtime";
import { LocalStorageSaveStore } from "@wickedways/play-runtime";
import { hollowHouse } from "@wickedways/campaigns/hollow-house";
import { seed } from "@wickedways/campaigns/seed";
import { crtSurface } from "@wickedways/play-surface/crt";
import { pncSurface } from "@wickedways/play-surface/pnc";

const app = document.getElementById("app");
if (app) {
  await bootLauncher(app, { campaigns: [hollowHouse, seed], surfaces: [crtSurface, pncSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
}
