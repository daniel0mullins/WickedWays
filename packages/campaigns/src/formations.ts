/**
 * `descriptorToFormation` — turns a data-driven {@link FormationDescriptor} (the
 * ts-rs binding) into a live-`Mob`-building {@link FormationBehavior}, byte-faithful
 * to the Rust `FormationDescriptor::build` + `World::maybe_spawn` drop seeding
 * (crates/wickedways-core/src/world/formation_descriptor.rs, formations.rs).
 *
 * Parity contracts mirrored here (verified by the Task-6 differential gate):
 *  1. Deterministic mob id scheme: `campaign-mob:{name.lowercase}` for the first
 *     mob in the formation, `…#{index+1}` for index ≥ 1 (a pair → `campaign-mob:rat`,
 *     `campaign-mob:rat#2`).
 *  2. Each `MobSpec.drops[j]` (an item key) becomes a drop built from a FRESH
 *     item factory `registry.item(key)()`, with id `{mobId}:drop#{j}` — matching
 *     the authored path (assembler.ts:231-234) but with the `campaign-mob:` id.
 *  3. The spawned mob is built with `inventorySlots: 0` (NOT the assembler's
 *     default of 2); the Mob constructor then widens slots to `max(0, drops.len)`,
 *     matching the Rust `slots = max(0, drops.len)`.
 *  4. `naturalAttack.power` carries the descriptor's `f64` straight through, so it
 *     round-trips to the same numeric shape the Rust descriptor emits.
 */
import { Mob } from "wickedways/lib/character/mob";
import { ProceduralViolation } from "wickedways/lib/util";
import type { CampaignRegistry, FormationBehavior } from "wickedways/lib/serialization/registry";
import type { CharacterId } from "wickedways/lib/character/character";
import type { ItemId, MaterialMap } from "wickedways/lib/inventory";
import type { FormationDescriptor } from "../../../generated/bindings/FormationDescriptor.ts";

/**
 * Build a {@link FormationBehavior} from a {@link FormationDescriptor}.
 *
 * @param descriptor The data-driven formation (mobs + their drops).
 * @param registry   Item-factory source for realizing `MobSpec.drops`. Required
 *                   only when a spec carries drops; a drop key with no registry
 *                   (or an unregistered key) throws a {@link ProceduralViolation}.
 */
export function descriptorToFormation(
  descriptor: FormationDescriptor,
  registry?: CampaignRegistry,
): FormationBehavior {
  return {
    build: (campaign) =>
      descriptor.mobs.map((spec, i) => {
        const base = `campaign-mob:${spec.name.toLowerCase()}`;
        const id = i === 0 ? base : `${base}#${i + 1}`;
        // Realize drops from FRESH factories with the `{mobId}:drop#{j}` id scheme.
        const drops = spec.drops.map((key, j) => {
          if (registry === undefined) {
            throw new ProceduralViolation(
              `descriptorToFormation: mob '${spec.name}' declares drop '${key}' but no registry was supplied.`,
            );
          }
          const item = registry.item(key)();
          item.id = `${id}:drop#${j}` as ItemId;
          return item;
        });
        const mob = new Mob({
          campaign,
          name: spec.name,
          stats: spec.stats,
          inventorySlots: 0,
          actionsPerRound: Number(spec.actionsPerRound),
          drops,
          baseEscapeChance: Number(spec.baseEscapeChance),
          materialDrops: spec.materialDrops as MaterialMap,
          lightAverse: spec.lightAverse,
          naturalAttack: spec.naturalAttack,
        });
        mob.id = id as CharacterId;
        return mob;
      }),
  };
}
