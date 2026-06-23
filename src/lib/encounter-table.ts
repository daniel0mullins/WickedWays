import { roll } from "./dice";
import { PLACE, SET_ORIGIN } from "./inventory";
import { Status } from "./status";
import { clamp, ProceduralViolation } from "./util";
import type { ICampaign } from "./campaign";
import type { IMob } from "./character/mob";
import type { IRoom } from "./room";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import type { EncounterTableSnapshot } from "./serialization/types";
import type { CampaignRegistry } from "./serialization/registry";

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

/** Constructor options for an {@link EncounterTable}. */
export interface EncounterTableOptions {
  /** Float source in `[0, 1)` driving spawn and selection rolls. */
  rng: () => number;
  /** Base encounter chance (0–100) before the room modifier. */
  baseChance: number;
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

  constructor(opts: EncounterTableOptions) {
    this.#rng = opts.rng;
    this.#baseChance = opts.baseChance;
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
   * Note: the first visit consumes the room's one chance even if no formations
   * are registered yet, so register formations before the party explores.
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

  /** Returns a plain-data snapshot of this table's state. */
  [SERIALIZE](): EncounterTableSnapshot {
    return {
      baseChance: this.#baseChance,
      visited: [...this.#visited],
      formations: this.#formations.map((f) => ({ behaviorKey: f.id, weight: f.weight })),
    };
  }

  /** Restores state from a snapshot, bypassing `addFormation` validation. */
  [HYDRATE](data: EncounterTableSnapshot, registry: CampaignRegistry): void {
    this.#baseChance = data.baseChance;
    this.#visited.clear();
    for (const id of data.visited) this.#visited.add(id);
    this.#formations.length = 0;
    for (const f of data.formations) {
      this.#formations.push({ id: f.behaviorKey, weight: f.weight, build: registry.formation(f.behaviorKey).build });
    }
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
