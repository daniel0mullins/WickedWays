/**
 * Manifest-boot guard: every shipped campaign manifest must boot on the WASM
 * Authority without a `validate_mechanics` rejection.
 *
 * This is the authoring-time guard for the cutover bug where the browser failed
 * to boot ("Mechanic 'dread' is not registered.") because `bootLauncher` never
 * threaded a campaign's scripted `behaviors` into the engine. Booting each
 * manifest here the same way `bootLauncher` does (reading `m.behaviors?.()`)
 * turns that runtime browser failure into a CI failure — a future scripted
 * campaign that forgets to set `behaviors` fails this test instead of shipping.
 */
import { describe, it, expect } from "vitest";
import { GameSession } from "@wickedways/play-runtime";
import type { SaveStore, SaveSlot, SurfaceState, CampaignManifest } from "@wickedways/play-runtime";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { SHIPPED_CAMPAIGNS } from "../campaigns.js";

// ── In-memory SaveStore (boot never touches it; required by SessionOptions) ────

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

type Behaviors = Parameters<typeof GameSession.start>[0]["behaviors"];

/** Boot a manifest exactly as `bootLauncher` does (launcher.ts) — reading
 *  `m.behaviors?.()` — so this test guards the manifest's own `behaviors` field.
 *  `behaviorsOverride` lets the teeth test simulate a manifest that forgot it. */
function bootManifest(m: CampaignManifest, behaviorsOverride?: Behaviors): GameSession {
  return GameSession.start({
    builder: m.builder(),
    registry: m.registry(),
    aliases: m.aliases,
    behaviors: behaviorsOverride ?? m.behaviors?.() ?? {},
    // Thread formations exactly as bootLauncher does — this also guards the
    // catalog stringify path against bigint i64 descriptor fields (a HH boot
    // with data-driven formations threw "Do not know how to serialize a BigInt"
    // before the session's BigInt→Number replacer was added).
    formations: m.formations?.() ?? {},
    playerName: m.playerName,
    archetype: m.archetype,
    saveStore: new MemSaveStore(),
    now: () => 0,
    seed: 0,
  });
}

describe("shipped campaign manifests boot on the WASM Authority", () => {
  it("registers at least one campaign", () => {
    expect(SHIPPED_CAMPAIGNS.length).toBeGreaterThan(0);
  });

  for (const m of SHIPPED_CAMPAIGNS) {
    it(`${m.slug} boots without a validate_mechanics rejection`, () => {
      expect(() => bootManifest(m)).not.toThrow();
    });
  }

  // Teeth: a scripted campaign booted WITHOUT its behaviors must be rejected —
  // this is the exact regression (bootLauncher not passing manifest.behaviors),
  // proving the positive assertions above are non-vacuous.
  it("rejects a scripted campaign booted without its behaviors", () => {
    const scripted = SHIPPED_CAMPAIGNS.find((m) => Object.keys(m.behaviors?.() ?? {}).length > 0);
    expect(scripted, "expected at least one shipped campaign with scripted behaviors").toBeDefined();
    expect(() => bootManifest(scripted!, {})).toThrow();
  });
});
