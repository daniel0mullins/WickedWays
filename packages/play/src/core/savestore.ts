import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { MapSnapshot } from "./map-model.js";

export interface SaveSlot { slot: string; savedAt: number; }
/** Play-surface state persisted beside the campaign snapshot (opaque to the engine). */
export interface SurfaceState { map?: MapSnapshot; }
export interface SaveStore {
  list(): Promise<SaveSlot[]>;
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number, surface?: SurfaceState): Promise<void>;
  load(slot: string): Promise<{ snapshot: CampaignSnapshot; surface?: SurfaceState } | null>;
  delete(slot: string): Promise<void>;
}

interface Envelope { savedAt: number; snapshot: CampaignSnapshot; surface?: SurfaceState; }
const PREFIX = "wickedways:save:";

export class LocalStorageSaveStore implements SaveStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  list(): Promise<SaveSlot[]> {
    const out: SaveSlot[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) continue;
      const env = JSON.parse(raw) as Envelope;
      out.push({ slot: key.slice(PREFIX.length), savedAt: env.savedAt });
    }
    return Promise.resolve(out);
  }
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number, surface?: SurfaceState): Promise<void> {
    const env: Envelope = { savedAt, snapshot, surface };
    this.storage.setItem(PREFIX + slot, JSON.stringify(env));
    return Promise.resolve();
  }
  load(slot: string): Promise<{ snapshot: CampaignSnapshot; surface?: SurfaceState } | null> {
    const raw = this.storage.getItem(PREFIX + slot);
    if (raw === null) return Promise.resolve(null);
    const env = JSON.parse(raw) as Envelope;
    return Promise.resolve({ snapshot: env.snapshot, surface: env.surface });
  }
  delete(slot: string): Promise<void> {
    this.storage.removeItem(PREFIX + slot);
    return Promise.resolve();
  }
}
