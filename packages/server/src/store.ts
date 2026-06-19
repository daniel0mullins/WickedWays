import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

/** Server-side serializable form of a {@link Membership}: the GM identity + seat→owner pairs. */
export interface MembershipState {
  gmIdentity: string;
  seats: [characterId: string, identity: string][];
}

/** One campaign's full durable state, written atomically. */
export interface CampaignRecord {
  seq: number; // the committed head this snapshot represents
  snapshot: CampaignSnapshot; // engine snapshot (carries schemaVersion)
  membership: MembershipState; // seat ownership at this seq
}

/**
 * Host-injected durable store for campaign records. Implementations MUST make
 * {@link CampaignStore.save} atomic: a torn or partial write must never be
 * observable by a later {@link CampaignStore.load}.
 */
export interface CampaignStore {
  load(campaignId: string): Promise<CampaignRecord | null>;
  save(campaignId: string, record: CampaignRecord): Promise<void>;
}
