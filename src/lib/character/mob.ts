import { ICampaign } from "../campaign";
import {
  DEPOSIT_MATERIALS,
  IItem,
  MaterialMap,
  SET_ORIGIN,
  STASH_DROP,
} from "../inventory";
import { Loot } from "../loot";
import { roll } from "../dice";
import { clamp, typedEntries } from "../util";
import { RECORD_ENCOUNTER } from "../codex";
import type { ICharacter } from "./character";
import { Combatant, ICombatant } from "./combatant";
import { Stats, StatType } from "./stats";
import type { CharacterOptions } from "./character";
import type { CharacterSnapshot } from "../serialization/types";
import type { HydrateContext } from "../serialization/context";

/** Where a mob comes from; gates key-item drops (see {@link Mob.onKnockOut}). */
export type MobOrigin = "room" | "campaign" | "unbound";

/** A non-player {@link ICombatant}, such as an enemy, that can also flee. */
export interface IMob extends ICombatant {
  /** Attempts a Health-gated flee through a random exit, recording an `escape`. */
  escape: () => void;
  /** Sets the mob's origin. Engine-internal; see {@link SET_ORIGIN}. */
  [SET_ORIGIN]: (origin: MobOrigin) => void;
}

/**
 * A hostile, non-player combatant. Carries `drops` (loaded into its inventory
 * and released on defeat) plus optional `materialDrops`, can {@link Mob.escape},
 * and distributes loot automatically when KO'd (see {@link Mob.onKnockOut}).
 */
export class Mob extends Combatant implements IMob {
  #origin: MobOrigin = "unbound";
  #baseEscapeChance: number;
  #materialDrops: MaterialMap;
  #lightAverse: boolean;

  /**
   * @param campaign - The campaign the mob belongs to.
   * @param name - Display name.
   * @param stats - Initial {@link Stats}.
   * @param inventorySlots - Inventory capacity; raised to fit `drops`. Defaults to 2.
   * @param actionsPerRound - Budgeted actions per turn. Defaults to 2.
   * @param drops - Items the mob carries and releases on defeat.
   * @param options - rng, affliction config, base escape chance, and material drops.
   */
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 2,
    actionsPerRound: number = 2,
    drops: IItem[],
    options: CharacterOptions & {
      baseEscapeChance?: number;
      materialDrops?: MaterialMap;
      lightAverse?: boolean;
    } = {},
  ) {
    const _inventorySlots = Math.max(inventorySlots, drops.length);
    super(campaign, name, stats, _inventorySlots, actionsPerRound, options);

    this.#baseEscapeChance = options.baseEscapeChance ?? 50;
    this.#materialDrops = options.materialDrops ?? {};
    this.#lightAverse = options.lightAverse ?? false;
    // Load drops into the inventory so "what the mob carries" IS its loot.
    for (const drop of drops) {
      this.receiveItem(drop);
    }

    this.isActionMap.set(this.escape, true);
  }

  /** A light-averse mob sees in the dark (can act there) but takes amplified damage when its room is lit. */
  override get seesInDark(): boolean {
    return this.#lightAverse;
  }

  /** A light-averse mob takes amplified damage while its room is lit. */
  protected override get lightAverse(): boolean {
    return this.#lightAverse;
  }

  /** Sets the mob's origin. Engine-internal seam. */
  [SET_ORIGIN](origin: MobOrigin) {
    this.#origin = origin;
  }

  // ---------------------------------------------------------------------------
  // Serialization hooks
  // ---------------------------------------------------------------------------

  protected override serializeKind(): "player" | "mob" { return "mob"; }

  protected override serializeExtra(snap: CharacterSnapshot): void {
    snap.origin = this.#origin;
    snap.baseEscapeChance = this.#baseEscapeChance;
    snap.materialDrops = { ...this.#materialDrops };
    snap.lightAverse = this.#lightAverse;
  }

  protected override hydrateExtra(data: CharacterSnapshot, _ctx: HydrateContext): void {
    if (data.origin) this.#origin = data.origin;
    // #baseEscapeChance/#materialDrops/#lightAverse were set from options in the bare ctor.
  }

  // ---------------------------------------------------------------------------

  /**
   * Attempts to flee the current room. Success is a Health-gated roll:
   * `roll(100) <= clamp(baseEscapeChance + effective Health, 0, 100)` *and* an
   * exit must exist. On success the mob moves through a randomly chosen exit
   * (gate-suppressed, so it does not consume a second action). Whether it
   * succeeds or fails, the `escape` action is recorded and the budget ticks.
   */
  escape() {
    if (!this.attemptAction(this.escape, false)) return;
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const threshold = clamp(
      this.#baseEscapeChance + this.effectiveStat(StatType.Health),
      0,
      100,
    );
    const rolled = roll(100, this.rng) <= threshold;
    const success = rolled && exits.length > 0;
    if (success) {
      const destination = exits[roll(exits.length, this.rng) - 1]!;
      this.withGateSuppressed(() => this.move(destination));
    }
    this.recordAction(this.escape, { kind: "escape", success });
  }

  /**
   * On defeat, distributes drops: material drops go to the campaign pool; held
   * items spawn a {@link Loot} box in the current room; key items are stashed
   * into that box only when the mob is room-attached (`origin === "room"`).
   * Does nothing with items if the mob is in no room (materials still deposit).
   */
  protected override onKnockOut() {
    if (Object.keys(this.#materialDrops).length > 0) {
      this.campaign[DEPOSIT_MATERIALS](this.#materialDrops);
      let by: ICharacter | undefined;
      try {
        by = this.campaign.activeCharacter;
      } catch {
        by = undefined;
      }
      for (const [component, qty] of typedEntries(this.#materialDrops) as Array<
        [keyof MaterialMap, number | undefined]
      >) {
        if (qty === undefined) continue;
        this.campaign[RECORD_ENCOUNTER](
          { kind: "material", material: component },
          by,
          this.currentRoom,
        );
      }
    }

    const room = this.currentRoom;
    if (!room) return;

    // Drops are loaded into the inventory via receiveItem (never equipped), so
    // the dropped items carry no equipped flag — no unequip step is needed here.
    const items = [...this.inventory.items];
    const keys = this.#origin === "room" ? [...this.inventory.keys] : [];
    if (items.length === 0 && keys.length === 0) return;

    for (const item of items) {
      this.relinquishItem(item);
    }
    const box = new Loot(`${this.name}'s remains`, items);

    for (const key of keys) {
      this.relinquishItem(key);
      box[STASH_DROP](key);
    }

    room.loot.set(box.id, box);
  }
}
