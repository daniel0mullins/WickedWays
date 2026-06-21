/**
 * Per-campaign chat configuration, authored on the template and carried in the
 * campaign snapshot. Inert data: the engine never acts on it — the comms server
 * reads it to gate features, and the client reads it to gate UI affordances.
 */
export interface ChatPolicy {
  /** Master switch: when false there is no chat subsystem, roster, or history. */
  enabled: boolean;
  /** Private identity→identity whispers (room-wide is the baseline when enabled). */
  whisper: boolean;
  /** Edit/delete own messages. */
  edit: boolean;
  /** Emoji reactions. */
  reactions: boolean;
  /** Per-identity read high-water marks. */
  readReceipts: boolean;
  /** Transient typing indicators. */
  typing: boolean;
  /** Initial backfill / pagination page size. NOT a retention cap — nothing is deleted. */
  backfillWindow: number;
}

/** All features on, 200-message window — the default for an authored multiplayer campaign. */
export const DEFAULT_CHAT_POLICY: ChatPolicy = {
  enabled: true,
  whisper: true,
  edit: true,
  reactions: true,
  readReceipts: true,
  typing: true,
  backfillWindow: 200,
};
