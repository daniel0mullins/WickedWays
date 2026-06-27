/**
 * Capstone regression test: full winning path through the Hollow House,
 * proving save-after-progress → undo (round-trip through deserializeCampaign)
 * → walk through the still-locked attic door with the iron key → win.
 *
 * This test drives the real parse → session.execute → Narrator stack using
 * the same typed command strings a player would type.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { GameSession } from "@wickedways/play-runtime";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, ALIASES, Rooms, Archetypes } from "@wickedways/campaigns/hollow-house";
import { parse, Narrator } from "@wickedways/play-surface-crt";
import type { SaveStore, SaveSlot, SurfaceState } from "@wickedways/play-runtime";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { Directions } from "wickedways/lib/room";

// ── In-memory SaveStore ───────────────────────────────────────────────────────

class MemSaveStore implements SaveStore {
  private readonly map = new Map<string, { savedAt: number; snapshot: CampaignSnapshot; surface?: SurfaceState }>();

  list(): Promise<SaveSlot[]> {
    return Promise.resolve([...this.map.entries()].map(([slot, v]) => ({ slot, savedAt: v.savedAt })));
  }
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number, surface?: SurfaceState): Promise<void> {
    this.map.set(slot, { savedAt, snapshot, surface });
    return Promise.resolve();
  }
  load(slot: string): Promise<{ snapshot: CampaignSnapshot; surface?: SurfaceState } | null> {
    const e = this.map.get(slot);
    return Promise.resolve(e ? { snapshot: e.snapshot, surface: e.surface } : null);
  }
  delete(slot: string): Promise<void> {
    this.map.delete(slot);
    return Promise.resolve();
  }
}

// ── Session factory ───────────────────────────────────────────────────────────

function newSession() {
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

// ── Text-command driver ───────────────────────────────────────────────────────
// Mirrors ui.ts handle() — parses lines, dispatches intents, records output.

function buildDriver(session: GameSession) {
  const narrator = new Narrator();
  const transcript: string[] = [];

  const push = (lines: string[]) => transcript.push(...lines);

  // Render the opening room description.
  push(narrator.renderRoom(session.view()));

  async function handle(line: string): Promise<void> {
    const before = session.view();
    const res = parse(line, before);
    switch (res.kind) {
      case "error":
        push([`[error] ${res.message}`]);
        return;
      case "ambiguous":
        push([`[ambiguous] ${res.candidates.map((c) => c.name).join(", or ")}`]);
        return;
      case "query":
        push(narrator.renderQuery(res.query, before));
        return;
      case "examine":
        push(narrator.renderExamine(res.target, before));
        return;
      case "meta": {
        if (res.meta === "save") {
          await session.save("slot1");
          push(["[meta] Saved."]);
        } else if (res.meta === "restore") {
          const { ok } = await session.restore("slot1");
          push([ok ? "[meta] Restored." : "[meta] No save found."]);
          if (ok) push(narrator.renderQuery("look", session.view()));
        } else {
          const ok = session.undo();
          push([ok ? "[meta] The last moment unwinds." : "[meta] Nothing to undo."]);
          if (ok) push(narrator.renderQuery("look", session.view()));
        }
        return;
      }
      case "intent": {
        const result = session.execute(res.intent);
        if (result.error) {
          push([`[error] ${result.error}`]);
          return;
        }
        const after = session.view();
        push(narrator.renderCues(result.cues));
        if (res.intent.kind === "move") push(narrator.renderRoom(after));
        return;
      }
    }
  }

  return { handle, transcript };
}

// ── Capstone test suite ───────────────────────────────────────────────────────

describe("capstone: full winning path with save/undo round-trip", () => {
  let session: GameSession;
  let handle: (line: string) => Promise<void>;
  let transcript: string[];

  beforeEach(() => {
    session = newSession();
    const driver = buildDriver(session);
    handle = driver.handle;
    transcript = driver.transcript;
  });

  it("drives the full winning path: save/undo round-trip then iron-key attic win", async () => {
    // ── 1. Foyer: get journal ─────────────────────────────────────────────────
    expect(session.view().room.name).toBe(Rooms.Foyer);

    await handle("open chest");                       // open foyer-table
    await handle("take journal");                     // take Water-Stained Journal
    expect(session.view().inventory.items.some((i) => i.name === "Water-Stained Journal")).toBe(true);

    // ── 2. Hall: get + equip poker ────────────────────────────────────────────
    await handle("n");                                // Foyer → Hall
    expect(session.view().room.name).toBe(Rooms.Hall);

    await handle("open chest");                       // open hall-stand
    await handle("take poker");                       // take Iron Fire-Poker
    await handle("equip poker");                      // equip Iron Fire-Poker
    expect(session.view().inventory.equippedNames).toContain("Iron Fire-Poker");

    // ── 3. Kitchen: get + equip lantern ──────────────────────────────────────
    await handle("w");                                // Hall → Kitchen
    expect(session.view().room.name).toBe(Rooms.Kitchen);

    await handle("open chest");                       // open kitchen-hook
    await handle("take lantern");                     // take Brass Lantern
    await handle("equip lantern");                    // equip Brass Lantern
    expect(session.view().inventory.equippedNames).toContain("Brass Lantern");

    // ── 4. Save, then move east (to Hall), then undo back to Kitchen ──────────
    // The attic door (Landing→North→Attic) is still locked at this point.

    await handle("save");
    expect(transcript.some((l) => l.includes("[meta] Saved."))).toBe(true);

    const turnBeforeMove = session.view().status.turn;

    await handle("e");                                // Kitchen → Hall
    expect(session.view().room.name).toBe(Rooms.Hall);

    await handle("undo");                             // undo the move → back to Kitchen
    expect(transcript.some((l) => l.includes("[meta] The last moment unwinds."))).toBe(true);

    // After undo, player is back in Kitchen with full inventory intact.
    expect(session.view().room.name).toBe(Rooms.Kitchen);
    expect(session.view().status.turn).toBe(turnBeforeMove);
    expect(session.view().inventory.items.some((i) => i.name === "Water-Stained Journal")).toBe(true);
    expect(session.view().inventory.equippedNames).toContain("Iron Fire-Poker");
    expect(session.view().inventory.equippedNames).toContain("Brass Lantern");

    // The attic door (Landing north) must still appear locked after the
    // deserializeCampaign round-trip — navigate to Landing to verify.
    await handle("e");                                // Kitchen → Hall
    await handle("n");                                // Hall → Landing
    expect(session.view().room.name).toBe(Rooms.Landing);
    const atticDoorLocked = session.view().lockedDoors.some((d) => d.dir === Directions.North);
    expect(atticDoorLocked).toBe(true);

    // ── 5. Continue to Cellar, defeat Revenant, get iron key ─────────────────
    await handle("s");                                // Landing → Hall
    await handle("s");                                // Hall → Foyer
    await handle("s");                                // Foyer → Cellar
    expect(session.view().room.name).toBe(Rooms.Cellar);

    // The lantern equip means the Cellar is now lit → we can attack.
    const revenantOccupants = session.view().occupants;
    expect(revenantOccupants.some((o) => o.name === "Revenant")).toBe(true);

    // Revenant Health=10, Sanity=8. Poker (modifier=5, stat=Health).
    // Mitigation: mitigator = Sanity = 8, damageMultiplier = (10-8)*0.2 = 0.4
    // Per-hit damage = 5*0.4 = 2. Takes 5 hits to reduce Health 10 → 0.
    for (let i = 0; i < 6; i++) {
      await handle("attack revenant");
    }

    // After defeat, iron key drops into the room's loot.
    await handle("open chest");                       // open the dropped loot box
    await handle("take key");                         // take Iron Key

    const ironKey = session.view().inventory.keys.find((k) => k.name === "Iron Key");
    expect(ironKey).toBeDefined();

    // ── 6. Navigate to Landing ────────────────────────────────────────────────
    await handle("n");                                // Cellar → Foyer
    await handle("n");                                // Foyer → Hall
    await handle("n");                                // Hall → Landing
    expect(session.view().room.name).toBe(Rooms.Landing);

    // With the iron key in hand the attic door precondition passes, so it now
    // appears in exits (passable), not in lockedDoors.
    expect(session.view().exits.some((e) => e.toName === Rooms.Attic)).toBe(true);

    // ── 7. Walk north into the attic door — key unlocks it → WIN ─────────────
    // The doorBehavior precondition passes (iron key in inventory),
    // the script runs (sets state.unlocked = true, returns the one-time opened line),
    // the player moves into the Attic holding the journal → win condition fires.

    await handle("n");

    // Player is now in the Attic.
    expect(session.view().room.name).toBe(Rooms.Attic);

    // Campaign resolved as won.
    expect(session.outcome).toBe("won");
    expect(session.finished).toBe(true);

    // Transcript contains the attic-door one-time pass line.
    const atticOpenLine = "The iron key grinds in the lock; the attic stairs open above you.";
    expect(transcript.some((l) => l.includes(atticOpenLine))).toBe(true);

    // Transcript contains the win narration.
    const winLine = "You climb into the attic with the journal in hand";
    expect(transcript.some((l) => l.includes(winLine))).toBe(true);
  });

  it("after undo, the attic door is still locked (no key in hand, exit still blocked)", async () => {
    // This is a focused regression for the crash under the old locked-door model:
    // after deserializeCampaign the attic exit must still be present and blocked.

    // Get to Kitchen with equipment.
    await handle("open chest");                       // Foyer: open, take journal
    await handle("take journal");
    await handle("n");                                // Hall
    await handle("open chest");
    await handle("take poker");
    await handle("equip poker");
    await handle("w");                                // Kitchen
    await handle("open chest");
    await handle("take lantern");
    await handle("equip lantern");

    // Save, move, then undo.
    await handle("save");
    await handle("e");                                // Kitchen → Hall
    await handle("undo");

    // Must be back in Kitchen after undo.
    expect(session.view().room.name).toBe(Rooms.Kitchen);

    // Navigate to Landing and confirm attic door is present but locked.
    await handle("e");                                // Kitchen → Hall
    await handle("n");                                // Hall → Landing
    expect(session.view().room.name).toBe(Rooms.Landing);

    // Without the iron key, the attic door is locked (appears in lockedDoors, not exits).
    const landingExitNames = session.view().exits.map((e) => e.toName);
    expect(landingExitNames).not.toContain(Rooms.Attic);

    const lockedAttic = session.view().lockedDoors.find((d) => d.dir === Directions.North);
    expect(lockedAttic).toBeDefined();

    // Attempting to go north without the key is blocked (doesn't move).
    await handle("n");
    expect(session.view().room.name).toBe(Rooms.Landing);
    expect(transcript.some((l) => l.includes("won't budge"))).toBe(true);
  });
});
