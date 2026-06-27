/**
 * Regression: drinking the Vial of Laudanum restores Sanity.
 *
 * The vial's `use` action once defaulted to a no-op, so `use` consumed it but
 * healed nothing. This drives the real parse → session.execute stack to the
 * Study, uses the vial, and asserts the heal lands (and the vial is consumed).
 */
import { describe, it, expect } from "vitest";
import { GameSession } from "@wickedways/play-runtime";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, ALIASES } from "../campaign/index.js";
import { parse } from "../text/parser.js";
import { Rooms, Archetypes } from "../campaign/ids.js";
import type { SaveStore, SaveSlot, SurfaceState } from "@wickedways/play-runtime";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

class MemSaveStore implements SaveStore {
  private readonly map = new Map<string, { savedAt: number; snapshot: CampaignSnapshot; surface?: SurfaceState }>();
  list(): Promise<SaveSlot[]> { return Promise.resolve([]); }
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number, surface?: SurfaceState): Promise<void> { this.map.set(slot, { savedAt, snapshot, surface }); return Promise.resolve(); }
  load(slot: string): Promise<{ snapshot: CampaignSnapshot; surface?: SurfaceState } | null> { const e = this.map.get(slot); return Promise.resolve(e ? { snapshot: e.snapshot, surface: e.surface } : null); }
  delete(slot: string): Promise<void> { this.map.delete(slot); return Promise.resolve(); }
}

function newSession(): GameSession {
  return GameSession.start({
    builder: hauntedHouseTemplate(),
    registry: buildHauntedHouseRegistry(),
    aliases: ALIASES,
    playerName: "Heir",
    archetype: Archetypes.Heir,
    saveStore: new MemSaveStore(),
    now: () => 0,
    rng: () => 0.5,
  });
}

// Parse + execute one command (intents only); mirrors ui.ts handle() enough.
function run(session: GameSession, line: string): void {
  const res = parse(line, session.view());
  if (res.kind === "intent") session.execute(res.intent);
}

describe("laudanum", () => {
  it("restores 6 Sanity when used and consumes the vial", () => {
    const session = newSession();

    // Route to the Study: arm up, take the lantern (light to fight + suppress
    // Dread), beat the Wraith for the brass key, then unlock the study door.
    const toStudy = [
      "n", "open chest", "take poker", "equip poker",       // Hall: poker
      "w", "open chest", "take lantern", "equip lantern",   // Kitchen: lantern
      "e", "n", "e",                                        // → Nursery (Wraith)
    ];
    for (const cmd of toStudy) run(session, cmd);

    for (let i = 0; i < 12; i++) {
      const wraith = session.view().occupants.find((o) => /wraith/i.test(o.name));
      if (!wraith || wraith.defeated) break;
      run(session, "attack wraith");
    }

    for (const cmd of ["open chest", "take key", "w", "w", "take vial"]) run(session, cmd);

    // Preconditions: we're in the Study, holding the vial.
    expect(session.view().room.name).toBe(Rooms.Study);
    expect(session.view().inventory.items.some((i) => i.name === "Vial of Laudanum")).toBe(true);

    const before = session.view().status.sanity;
    run(session, "use vial");
    const after = session.view();

    expect(after.status.sanity).toBe(before + 6);                                   // heal landed
    expect(after.inventory.items.some((i) => i.name === "Vial of Laudanum")).toBe(false); // consumed
  });
});
