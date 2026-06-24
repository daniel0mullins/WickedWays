import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

export interface SaveSlot { slot: string; savedAt: number; }
export interface SaveStore {
  list(): Promise<SaveSlot[]>;
  save(slot: string, snapshot: CampaignSnapshot, savedAt: number): Promise<void>;
  load(slot: string): Promise<CampaignSnapshot | null>;
  delete(slot: string): Promise<void>;
}

interface Envelope { savedAt: number; snapshot: CampaignSnapshot; }
const PREFIX = "wickedways:save:";

export class LocalStorageSaveStore implements SaveStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async list(): Promise<SaveSlot[]> {
    const out: SaveSlot[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) continue;
      const env = JSON.parse(raw) as Envelope;
      out.push({ slot: key.slice(PREFIX.length), savedAt: env.savedAt });
    }
    return out;
  }
  async save(slot: string, snapshot: CampaignSnapshot, savedAt: number): Promise<void> {
    const env: Envelope = { savedAt, snapshot };
    this.storage.setItem(PREFIX + slot, JSON.stringify(env));
  }
  async load(slot: string): Promise<CampaignSnapshot | null> {
    const raw = this.storage.getItem(PREFIX + slot);
    if (raw === null) return null;
    return (JSON.parse(raw) as Envelope).snapshot;
  }
  async delete(slot: string): Promise<void> {
    this.storage.removeItem(PREFIX + slot);
  }
}
