import { ProceduralViolation } from "../util";
import { SCHEMA_VERSION } from "./types";
import type { CampaignSnapshot } from "./types";
import type { CampaignRegistry } from "./registry";
import type { Campaign } from "../campaign";

export function deserializeCampaign(
  data: CampaignSnapshot,
  _opts: { registry: CampaignRegistry; rng?: () => number },
): Campaign {
  migrate(data);
  throw new Error("not implemented");
}

/** Upgrades older snapshots to the current schema; rejects unknown/newer versions. */
export function migrate(data: CampaignSnapshot): CampaignSnapshot {
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new ProceduralViolation(
      `Unsupported snapshot schemaVersion ${data.schemaVersion}; expected ${SCHEMA_VERSION}.`,
    );
  }
  return data;
}
