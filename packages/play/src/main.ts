import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { GameSession } from "./core/session.js";
import { LocalStorageSaveStore } from "./core/savestore.js";
import { hollowHouse } from "./campaign/manifest.js";
import { AudioRuntime } from "./audio/audio-runtime.js";
import { crtSurface } from "./text/surface.js";

const app = document.getElementById("app");
if (app) {
  const m = hollowHouse;
  const session = GameSession.start({
    builder: m.builder(),
    registry: m.registry(),
    aliases: m.aliases,
    playerName: m.playerName,
    archetype: m.archetype,
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
  const audio = AudioRuntime.forCampaign(m.audio);
  crtSurface.mount({
    app,
    session,
    manifest: m,
    themes: [crtSurface.defaultTheme],
    audio,
    onExit: () => {},
  });
}
