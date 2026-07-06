/**
 * TS "shadow" of the Rust `conformance:wraith` FormationBehavior
 * (crates/wickedways-core/src/world/formations.rs). `build` returns one fixed mob
 * with the SAME deterministic id the Rust `build_wraith` assigns. `maybeSpawn` sets
 * origin "campaign" AFTER build (via the SET_ORIGIN seam), so the shadow does NOT
 * set origin — a freshly built shadow mob carries the Mob default ("unbound"),
 * mirroring the Rust `origin: None` before placement.
 *
 * Field-by-field parity with `build_wraith` (post-serialization):
 *   id "campaign-mob:wraith", name "Wraith", kind "mob",
 *   stats { health: 4, sanity: 0, energy: 3 }, actionsPerRound 1,
 *   inventory { slots: 0 } (no drops → capacity stays 0), plus the TS Mob
 *   serializer's always-emitted defaults: baseEscapeChance 50, materialDrops {},
 *   lightAverse false, naturalAttack { stat: "health", power: 1 }.
 */
import type { FormationBehavior } from "wickedways/lib/serialization/registry";
import { Mob } from "wickedways/lib/character/mob";
import { StatType } from "wickedways/lib/character/stats";
import type { CharacterId } from "wickedways/lib/character/character";

/** The formation-behavior registry key (mirrors the Rust `formation()` match arm). */
export const WRAITH_KEY = "conformance:wraith";
/** The deterministic spawned-mob id (mirrors Rust `conformance::WRAITH_ID`). */
export const WRAITH_ID = "campaign-mob:wraith";

export const wraithFormationShadow: FormationBehavior = {
  build: (campaign) => {
    const mob = new Mob({
      campaign,
      name: "Wraith",
      stats: {
        [StatType.Health]: 4,
        [StatType.Sanity]: 0,
        [StatType.Energy]: 3,
      },
      inventorySlots: 0,
      actionsPerRound: 1,
      drops: [],
    });
    mob.id = WRAITH_ID as CharacterId;
    return [mob];
  },
};
