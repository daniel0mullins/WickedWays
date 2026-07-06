/**
 * TS "shadow" of the Rust `conformance:visit-counter` SceneBehavior
 * (crates/wickedways-core/src/world/scenes.rs), reproduced byte-for-byte:
 *   can_play:   state.count (default 0) < 3  AND  the room is occupied
 *   run_script: count = (state.count ?? 0) + 1; state.count = count;
 *               emit one cue: `The ${room.name} stirs (visit ${count}).`
 */
import type { SceneBehavior } from "wickedways/lib/serialization/registry";
import type { MechanicCue } from "wickedways/lib/mechanics/mechanic";

export const VISIT_COUNTER_KEY = "conformance:visit-counter";

export const visitCounterShadow: SceneBehavior = {
  preconditions: [
    (room, state) =>
      ((state as { count?: number }).count ?? 0) < 3 && room.occupants.length > 0,
  ],
  script: (room, state): MechanicCue[] => {
    const s = state as { count?: number };
    const count = (s.count ?? 0) + 1;
    s.count = count;
    return [{ text: `The ${room.name} stirs (visit ${count}).` }];
  },
};
