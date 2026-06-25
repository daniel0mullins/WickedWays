import { GameSession } from "./core/session.js";
import { LocalStorageSaveStore } from "./core/savestore.js";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, ALIASES } from "./campaign/index.js";
import { Archetypes } from "./campaign/ids.js";
import { mountTerminal } from "./text/ui.js";

const app = document.getElementById("app");
if (app) {
  const session = GameSession.start({
    builder: hauntedHouseTemplate(),
    registry: buildHauntedHouseRegistry(),
    aliases: ALIASES,
    playerName: "Heir",
    archetype: Archetypes.Heir,
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
  mountTerminal(app, session);
}
