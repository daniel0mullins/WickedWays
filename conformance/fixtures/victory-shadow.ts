/**
 * The `conformance:round-reached` victory condition — a TS "shadow" reproducing
 * the Rust `conformance::ROUND_REACHED` behavior byte-for-byte
 * (crates/wickedways-core/src/world/victory.rs): fires when the (post-increment)
 * round has reached THRESHOLD (2).
 *
 * Shared by every victory conformance generator so the shadow cannot drift.
 */
import type { ICampaign } from "wickedways/lib/campaign";

export const ROUND_REACHED_KEY = "conformance:round-reached";

/** THRESHOLD = 2, matching Rust `conformance::THRESHOLD`. */
export const roundReached = (campaign: ICampaign): boolean => campaign.round >= 2;
