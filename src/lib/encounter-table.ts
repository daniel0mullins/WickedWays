import { roll } from "./dice";
import { PLACE, SET_ORIGIN } from "./inventory";
import { Status } from "./status";
import { clamp, ProceduralViolation } from "./util";
import type { ICampaign } from "./campaign";
import type { IMob } from "./character/mob";
import type { IRoom } from "./room";

/**
 * A roving encounter: a weighted entry in an {@link EncounterTable}. `build`
 * mints FRESH mobs each spawn (a reusable pool cannot hand out the same KO'd
 * instances twice) and should inject the campaign rng into the mobs it builds.
 */
export interface Formation {
  /** Stable identifier. */
  id: string;
  /** Relative selection weight (higher = more likely). */
  weight: number;
  /** Factory that builds this formation's mobs for one spawn. */
  build: (campaign: ICampaign) => IMob[];
}

/**
 * Owns a campaign's roving {@link Formation}s and decides, on first entry to a
 * room, whether one spawns. All randomness routes through the injected `rng`.
 */
export class EncounterTable {
  #formations: Formation[] = [];
  #visited = new Set<string>();
  #rng: () => number;
  #baseChance: number;

  /**
   * @param rng - Float source in `[0, 1)` driving spawn and selection rolls.
   * @param baseChance - Base encounter chance (0–100) before the room modifier.
   */
  constructor(rng: () => number, baseChance: number) {
    this.#rng = rng;
    this.#baseChance = baseChance;
  }

  /**
   * Registers a formation. Rejects one whose mobs carry key-item drops: roving
   * mobs may not drop keys (only room-attached mobs can). Validation mints one
   * sample via `build` and inspects the produced mobs' keyrings.
   *
   * @throws {@link ProceduralViolation} if the weight is not positive, or if any
   *   sampled mob carries a key drop.
   */
  addFormation(formation: Formation, campaign: ICampaign) {
    if (formation.weight <= 0) {
      throw new ProceduralViolation("A formation's weight must be greater than 0.");
    }
    for (const mob of formation.build(campaign)) {
      if (mob.inventory.keys.length > 0) {
        throw new ProceduralViolation(
          "A roving formation's mobs cannot drop key items.",
        );
      }
    }
    this.#formations.push(formation);
  }

  /**
   * Decides whether to spawn a formation as a player enters `room`. Rolls only
   * on the first visit (the room is marked visited regardless of outcome) and
   * never when an active mob is already present. On success, a weighted
   * formation is built, marked campaign-origin, and placed in the room.
   *
   * @returns The mobs spawned (empty if none).
   */
  maybeSpawn(room: IRoom, campaign: ICampaign): IMob[] {
    if (this.#visited.has(room.id)) return [];
    this.#visited.add(room.id);

    const partyIds = new Set(campaign.party.map((p) => p.id));
    const activeMobPresent = room.occupants.some(
      (o) => !partyIds.has(o.id) && !o.status.includes(Status.KO),
    );
    if (activeMobPresent) return [];
    if (this.#formations.length === 0) return [];

    const threshold = clamp(this.#baseChance * room.spawnModifier, 0, 100);
    if (roll(100, this.#rng) > threshold) return [];

    const mobs = this.#select().build(campaign);
    for (const mob of mobs) {
      mob[SET_ORIGIN]("campaign");
      mob[PLACE](room);
    }
    return mobs;
  }

  /** Picks a formation weighted by `weight`. */
  #select(): Formation {
    const total = this.#formations.reduce((sum, f) => sum + f.weight, 0);
    let r = roll(total, this.#rng);
    for (const formation of this.#formations) {
      r -= formation.weight;
      if (r <= 0) return formation;
    }
    return this.#formations[this.#formations.length - 1]!;
  }
}
