import type { ICampaign } from "./campaign";
import type { AssetRef } from "./presentation";

/** How a campaign ended, or that it is still running. */
export type CampaignOutcome =
  | "ongoing"
  | "won"
  | "lost"
  | "timed-out"
  | "ended";

/**
 * Surface-agnostic authored prose for an outcome. Plain data — it serializes
 * natively (unlike a predicate) and any play surface renders it however it
 * likes. `sound` reuses the engine's existing {@link AssetRef} convention, so
 * no new presentation type is introduced.
 */
export interface OutcomeNarration {
  readonly text?: string;
  readonly sound?: AssetRef;
}

/**
 * A named win/loss predicate plus its authored prose. `key` is the registry
 * key the `test` was resolved from; `narration` is per-campaign content.
 */
export interface VictoryCondition {
  readonly key: string;
  readonly test: (campaign: ICampaign) => boolean;
  readonly narration?: OutcomeNarration;
}

/** The resolved result of a round-end evaluation. */
export interface OutcomeResult {
  /** Never "ended" — that is the manual {@link ICampaign.endCampaign} path. */
  readonly status: CampaignOutcome;
  /** The condition that fired (for "won"/"lost"); absent otherwise. */
  readonly condition?: VictoryCondition;
}

/**
 * Pure round-end resolution. Loss conditions are evaluated before win
 * conditions; the maxRounds ceiling resolves to "timed-out" only if no
 * win/loss condition fired this round.
 */
export function resolveOutcome(input: {
  round: number;
  maxRounds: number;
  winConditions: readonly VictoryCondition[];
  loseConditions: readonly VictoryCondition[];
  campaign: ICampaign;
}): OutcomeResult {
  const { round, maxRounds, winConditions, loseConditions, campaign } = input;

  for (const c of loseConditions) {
    if (c.test(campaign)) return { status: "lost", condition: c };
  }
  for (const c of winConditions) {
    if (c.test(campaign)) return { status: "won", condition: c };
  }
  if (round >= maxRounds) return { status: "timed-out" };
  return { status: "ongoing" };
}
