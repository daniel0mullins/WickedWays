import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { GameSession } from "./core/session.js";
import { LocalStorageSaveStore } from "./core/savestore.js";
import { hollowHouse } from "./campaign/manifest.js";
import { mountTerminal } from "./text/ui.js";

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
  mountTerminal(app, session, { title: m.title, intro: m.intro, buttonText: m.buttonText });
}
