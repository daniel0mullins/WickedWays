/**
 * Per-campaign A/V (WebRTC call) configuration, authored on the template and
 * carried in the campaign snapshot. Inert data: the engine never acts on it — the
 * comms server reads it to gate the call, and the client reads it to gate UI.
 */
export interface AvPolicy {
  /** Master switch: when false there is no A/V call subsystem for this campaign. */
  enabled: boolean;
  /** Whether cameras are allowed at all (vs an audio-only table). */
  video: boolean;
  /** Hard cap on simultaneous call members (protects the full mesh). */
  maxParticipants: number;
}

/** A/V on, video allowed, 6-participant cap — the default for an authored multiplayer campaign. */
export const DEFAULT_AV_POLICY: AvPolicy = { enabled: true, video: true, maxParticipants: 6 };
