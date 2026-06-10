import { Brand } from "./brand";
import { IPlayerCharacter } from "./character/player-character";
import { DEPOSIT_MATERIALS, type MaterialMap } from "./inventory";
import { generateId, ProceduralViolation, typedEntries } from "./util";

/** Unique identifier for a {@link Campaign}. */
export type CampaignId = Brand<string, "CampaignId">;

/**
 * A play session: the ordered party of player characters, the round counter,
 * and the turn cycle that advances through them. One player acts as the game
 * master (GM). A campaign must be started with {@link ICampaign.beginCampaign}
 * before its turn-management methods may be used.
 */
export interface ICampaign {
  // ### Properties
  id: CampaignId;
  /** The player characters taking part, in turn order. */
  party: IPlayerCharacter[];
  title: string;
  /** Read-only view of the party's shared raw-material pool. */
  get materials(): Readonly<MaterialMap>;
  /** Adds raw materials to the pool. Engine-internal; see {@link DEPOSIT_MATERIALS}. */
  [DEPOSIT_MATERIALS](mats: MaterialMap): void;

  /** Round count at which the campaign automatically ends. */
  readonly maxRounds: number;

  /** The player whose turn it currently is. */
  get activeCharacter(): IPlayerCharacter;
  /** The current game master, or `undefined` if none has been assigned. */
  get gm(): IPlayerCharacter | undefined;
  /** Sets the GM; only permitted before the campaign has begun. */
  set gm(pc: IPlayerCharacter | undefined);
  /** The current round number, starting at 0. */
  get round(): number;

  // ### Methods
  /** Whether the pool currently holds at least `mats`. */
  canAfford: (mats: MaterialMap) => boolean;
  /** Removes materials from the pool. Throws if the pool is short. */
  withdrawMaterials: (mats: MaterialMap) => void;
  /** Grants materials once per `claimId`; later calls with the same id are ignored. */
  claimMaterials: (claimId: string, mats: MaterialMap) => void;
  /** Starts the campaign once a valid party and GM are in place. */
  beginCampaign: () => void;
  /** Marks a running campaign finished. */
  endCampaign: () => void;
  /** Advances the round once every party member has acted. */
  endRound: () => void;
  /** Adds a player to a running campaign's party. */
  addPlayer: (c: IPlayerCharacter) => void;
  /** Removes a player from the party (the GM may not leave). */
  leaveCampaign: (c: IPlayerCharacter) => void;
  /** Marks the active player as having acted and advances the turn. */
  nextPlayer: () => void;
  /** Transfers the GM role to another player mid-campaign. */
  transfer: (c: IPlayerCharacter) => void;
}

/**
 * Default {@link ICampaign} implementation.
 *
 * Tracks lifecycle (started/finished), the active turn position, and which
 * party members have acted in the current round. Most mutating methods assert
 * the campaign is running and throw {@link ProceduralViolation} otherwise.
 */
export class Campaign implements ICampaign {
  id: CampaignId;
  title: string;
  party: IPlayerCharacter[];
  #round: number;
  #gm: IPlayerCharacter | undefined;
  readonly maxRounds: number;

  #materials: MaterialMap = {};
  #claims: Set<string> = new Set<string>();
  #started = false;
  #finished = false;
  #activeCharacterIndex: number = 0;
  #actedThisRound: WeakMap<IPlayerCharacter, boolean>;

  get round() {
    return this.#round;
  }

  get materials(): Readonly<MaterialMap> {
    return { ...this.#materials };
  }

  /**
   * Guards against replacing the pool wholesale.
   * @throws {@link ProceduralViolation} always — deposit via the engine-internal
   *   {@link DEPOSIT_MATERIALS} or {@link Campaign.claimMaterials}.
   */
  set materials(_value: MaterialMap) {
    throw new ProceduralViolation("Cannot set 'materials' directly");
  }

  get gm() {
    return this.#gm;
  }

  /**
   * Assigns the GM before the campaign starts.
   * @throws {@link ProceduralViolation} if the campaign has already begun; use
   *   {@link Campaign.transfer} instead.
   */
  set gm(pc: IPlayerCharacter | undefined) {
    if (this.#started) {
      throw new ProceduralViolation(
        "Cannot set the GM after the campaign has begun; use transfer() instead",
      );
    }
    this.#gm = pc;
  }

  /** @throws {@link ProceduralViolation} if the active character cannot be resolved. */
  get activeCharacter() {
    const activeCharacter = this.party[this.#activeCharacterIndex];
    if (activeCharacter) {
      return activeCharacter;
    } else {
      throw new ProceduralViolation("Unable to resolve active character");
    }
  }

  #resetActivity() {
    for (const character of this.party) {
      this.#actedThisRound.set(character, false);
    }
  }

  #assertRunning() {
    if (!this.#started) {
      throw new ProceduralViolation("Campaign has not begun");
    }
    if (this.#finished) {
      throw new ProceduralViolation("Campaign has already finished");
    }
  }

  /**
   * @param title - Display title of the campaign.
   * @param maxRounds - Round count at which the campaign auto-ends. Defaults to 100.
   */
  constructor(title: string, maxRounds: number = 100) {
    this.id = generateId<CampaignId>();
    this.title = title;
    this.party = [];
    this.#round = 0;
    this.#gm = undefined;
    this.maxRounds = maxRounds;

    this.#actedThisRound = new WeakMap<IPlayerCharacter, boolean>();
    this.#resetActivity();

    this.#activeCharacterIndex = 0;
  }

  /**
   * Starts the campaign, after which the GM can no longer be set directly and
   * turn management becomes available.
   *
   * @throws {@link ProceduralViolation} if already started, if the party is
   *   empty, or if the GM is not a member of the party.
   */
  beginCampaign() {
    if (this.#started) {
      throw new ProceduralViolation("Campaign has already begun");
    }
    if (this.party.length === 0) {
      throw new ProceduralViolation("Cannot begin a campaign with no party");
    }
    if (!this.#gm || !this.party.includes(this.#gm)) {
      throw new ProceduralViolation(
        "Cannot begin a campaign whose GM is not a member of the party",
      );
    }
    this.#started = true;
  }

  /**
   * Marks the campaign finished.
   * @throws {@link ProceduralViolation} if the campaign is not currently running.
   */
  endCampaign() {
    this.#assertRunning();
    this.#finished = true;
  }

  /**
   * Advances to the next round once every party member has acted, ending the
   * campaign if {@link Campaign.maxRounds} is reached.
   *
   * @throws {@link ProceduralViolation} if not running, or if called before all
   *   characters have acted this round.
   */
  endRound() {
    this.#assertRunning();
    const allPartyActed = this.party.every((c) => this.#actedThisRound.get(c));
    if (allPartyActed) {
      this.#round = this.#round + 1;
      if (this.#round >= this.maxRounds) {
        this.endCampaign();
      }
      this.#resetActivity();
    } else {
      throw new ProceduralViolation(
        "Attempted to end round before all characters have acted",
      );
    }
  }

  /**
   * Adds a player to the party.
   * @param c - The player character to add.
   * @throws {@link ProceduralViolation} if the campaign is not running.
   */
  addPlayer(c: IPlayerCharacter) {
    this.#assertRunning();
    this.party.push(c);
  }

  /**
   * Removes a player from the party, keeping the turn position pointed at the
   * same upcoming player.
   *
   * @param c - The player character leaving.
   * @throws {@link ProceduralViolation} if not running, or if `c` is the GM
   *   (transfer the role first).
   */
  leaveCampaign(c: IPlayerCharacter) {
    this.#assertRunning();
    if (this.gm === c) {
      throw new ProceduralViolation(
        "GM cannot leave the campaign, transfer the campaign first",
      );
    }

    const index = this.party.indexOf(c);
    this.party = this.party.filter((pc) => pc !== c);

    if (index !== -1) {
      // Keep the active index pointing at the same turn position: shift it down
      // when an earlier member leaves, and wrap to the start if it now dangles
      // past the end of the (shrunk) party.
      if (index < this.#activeCharacterIndex) {
        this.#activeCharacterIndex -= 1;
      } else if (this.#activeCharacterIndex >= this.party.length) {
        this.#activeCharacterIndex = 0;
      }
    }
  }

  /**
   * Marks the active character as having acted and advances to the next player,
   * wrapping to the first and ending the round after the last.
   *
   * @throws {@link ProceduralViolation} if the campaign is not running.
   */
  nextPlayer() {
    this.#assertRunning();
    this.#actedThisRound.set(this.activeCharacter, true);
    const nextIndex = this.#activeCharacterIndex + 1;
    if (nextIndex === this.party.length) {
      this.#activeCharacterIndex = 0;
      this.endRound();
    } else {
      this.#activeCharacterIndex = nextIndex;
    }
  }

  /**
   * Transfers the GM role to another player while the campaign is running.
   *
   * @param c - The player character to make GM.
   * @throws {@link ProceduralViolation} if the campaign is not running.
   */
  transfer(c: IPlayerCharacter) {
    this.#assertRunning();
    this.#gm = c;
  }

  /**
   * Adds raw materials to the party pool, summing by component. Engine-internal:
   * the Item Destroy wrapper, {@link Character.harvest}, and
   * {@link Campaign.claimMaterials} are its only callers.
   *
   * @param mats - Quantities to add, by component type.
   */
  [DEPOSIT_MATERIALS](mats: MaterialMap) {
    for (const [component, qty] of typedEntries(mats) as Array<
      [keyof MaterialMap, number | undefined]
    >) {
      if (qty === undefined) continue;
      this.#materials[component] = (this.#materials[component] ?? 0) + qty;
    }
  }

  /**
   * @param mats - Quantities to test against the pool.
   * @returns Whether every requested component is present at ≥ the requested amount.
   */
  canAfford(mats: MaterialMap): boolean {
    return (
      typedEntries(mats) as Array<[keyof MaterialMap, number | undefined]>
    ).every(
      ([component, qty]) =>
        qty === undefined || (this.#materials[component] ?? 0) >= qty,
    );
  }

  /**
   * Grants materials once per `claimId`. The first call with a given id deposits
   * and records the id; later calls with the same id are no-ops. The farm-proof
   * public grant for scene/quest scripts that have no physical cache.
   *
   * @param claimId - A stable id identifying this one-time grant.
   * @param mats - Quantities to grant on the first claim.
   */
  claimMaterials(claimId: string, mats: MaterialMap) {
    if (this.#claims.has(claimId)) {
      return;
    }
    this.#claims.add(claimId);
    this[DEPOSIT_MATERIALS](mats);
  }

  /**
   * Spends materials from the pool, removing any component that reaches zero. The
   * pool is checked up front, so a failed withdrawal leaves it unchanged.
   *
   * @param mats - Quantities to remove, by component type.
   * @throws {@link ProceduralViolation} if the pool cannot cover `mats`.
   */
  withdrawMaterials(mats: MaterialMap) {
    if (!this.canAfford(mats)) {
      throw new ProceduralViolation("Insufficient materials in the party pool");
    }
    for (const [component, qty] of typedEntries(mats) as Array<
      [keyof MaterialMap, number | undefined]
    >) {
      if (qty === undefined) continue;
      const remaining = (this.#materials[component] ?? 0) - qty;
      if (remaining > 0) {
        this.#materials[component] = remaining;
      } else {
        delete this.#materials[component];
      }
    }
  }
}
