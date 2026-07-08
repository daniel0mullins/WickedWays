import { Brand } from "./brand";
import { IPlayerCharacter } from "./character/player-character";
import { DEPOSIT_MATERIALS, type MaterialMap } from "./inventory";
import { generateId, ProceduralViolation, typedEntries } from "./util";
import type { CraftingRecipe, RecipeId } from "./crafting";
import { EncounterTable, type Formation } from "./encounter-table";
import type { IRoom } from "./room";
import type { IMob } from "./character/mob";
import type { Archetype, ArchetypeId } from "./archetype";
import { EMIT_CUE, NOTE_ENCOUNTERS } from "./presentation";
import type { ActionKind, AssetRef, PresentationCue } from "./presentation";
import { Status } from "./status";
import type { CharacterId, ICharacter } from "./character/character";
import { Codex, RECORD_ENCOUNTER } from "./codex";
import type { CodexEncounterEvent, CodexEntry, ICodex } from "./codex";
import { FIND_CHARACTER, FIND_ANY_CHARACTER, DISPATCH_TURN, DISPATCH_ACTION, TRANSFORM_DAMAGE, INVOKE_MECHANIC_ACTION } from "./mechanics/symbols";
import { roll } from "./dice";
import type { CampaignView, CharacterView, HookCtx, JsonObject, JsonValue, DamageView } from "./mechanics/mechanic";
import { MAX_EFFECTS_PER_EVENT } from "./mechanics/mechanic";
import { runReducers, runDamageTransformers } from "./mechanics/dispatch";
import { applyEffect } from "./mechanics/apply";
import type { ActionDetail } from "./character/history";
import { StatType } from "./character/stats";
import {
  SERIALIZE,
  HYDRATE,
  HYDRATE_CODEX,
  HYDRATE_CATALOG,
  HYDRATE_CODEX_ENTRIES,
} from "./serialization/symbols";
import type { CampaignCoreSnapshot } from "./serialization/types";
import type { HydrateContext } from "./serialization/context";
import type { CampaignRegistry } from "./serialization/registry";
import { resolveOutcome } from "./victory";
import type { CampaignOutcome, OutcomeNarration, VictoryCondition } from "./victory";
import { DEFAULT_CHAT_POLICY } from "./chat-policy";
import type { ChatPolicy } from "./chat-policy";
import { DEFAULT_AV_POLICY } from "./av-policy";
import type { AvPolicy } from "./av-policy";
import type { LiveMechanic } from "./mechanics/mechanic";

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
  /** Read-only view of the recipes the party can currently craft. */
  get knownRecipes(): ReadonlyMap<RecipeId, CraftingRecipe>;
  /** Read-only view of the archetypes registered on this campaign. */
  get archetypes(): ReadonlyMap<ArchetypeId, Archetype>;
  /** Read-only view of everything the party has encountered. */
  get codex(): ICodex;
  /** This campaign's chat configuration (inert engine data; consumed by comms + UI). */
  get chatPolicy(): ChatPolicy;
  /** This campaign's A/V configuration (inert engine data; consumed by comms + UI). */
  get avPolicy(): AvPolicy;
  /** Whether the campaign has begun (turn management active). */
  get started(): boolean;
  /** Whether the campaign has ended (won, lost, timed out, or manually ended). */
  get finished(): boolean;
  /** The resolved outcome, or "ongoing" while still in play. */
  get outcome(): CampaignOutcome;
  /** Registry key of the win/loss condition that fired, if any. */
  get outcomeReason(): string | undefined;
  /** Authored prose for the resolved outcome (text + optional sound), if any. */
  get outcomeNarration(): OutcomeNarration | undefined;

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
  /** Subscribes a handler to the presentation cue stream. */
  onCue: (handler: (cue: PresentationCue) => void) => void;
  /** Removes a previously-subscribed cue handler (no-op if not subscribed). */
  offCue: (handler: (cue: PresentationCue) => void) => void;
  /** Publishes a cue to subscribers. Engine-internal; see {@link EMIT_CUE}. */
  [EMIT_CUE]: (cue: PresentationCue) => void;
  /** Whether the pool currently holds at least `mats`. */
  canAfford: (mats: MaterialMap) => boolean;
  /** Removes materials from the pool. Throws if the pool is short. */
  withdrawMaterials: (mats: MaterialMap) => void;
  /** Grants materials once per `claimId`; later calls with the same id are ignored. */
  claimMaterials: (claimId: string, mats: MaterialMap) => void;
  /** Whether the party knows `recipeId`. */
  knows: (recipeId: RecipeId) => boolean;
  /** Marks a recipe known to the whole party; idempotent by id (first wins). */
  discoverRecipe: (recipe: CraftingRecipe, discoveredBy?: ICharacter) => void;
  /** Registers an archetype in the catalog; idempotent by id (first wins). */
  registerArchetype: (archetype: Archetype) => void;
  /** Starts the campaign once a valid party and GM are in place. */
  beginCampaign: () => void;
  /** Manually ends a running campaign with the `ended` outcome (a deliberate GM stop). */
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
  /** Registers a roving formation; rejects one whose mobs drop key items. */
  addFormation: (formation: Formation) => void;
  /** Spawn check for a player entering `room`; returns any mobs spawned. */
  maybeSpawn: (room: IRoom) => IMob[];
  /** Emits first-encounter cues for active mobs in a room a character entered. Engine-internal. */
  [NOTE_ENCOUNTERS]: (character: ICharacter, room: IRoom) => void;
  /** Records a party encounter into the codex. Engine-internal; see {@link RECORD_ENCOUNTER}. */
  [RECORD_ENCOUNTER]: (
    event: CodexEncounterEvent,
    by: ICharacter | undefined,
    where: IRoom | null,
  ) => void;
  /** Fires turn-phase hooks for all enabled mechanics. Engine-internal. */
  [DISPATCH_TURN]: (phase: "start" | "end", actor: IPlayerCharacter) => void;
  /** Fires `onAction` hooks for the given budgeted action. Engine-internal. */
  [DISPATCH_ACTION]: (detail: ActionDetail, actor: IPlayerCharacter) => void;
  /** Runs all `modifyDamage` transformers and returns the final damage amount. Engine-internal. */
  [TRANSFORM_DAMAGE]: (dv: DamageView) => number;
  /** Invokes a named custom action on a mechanic and applies its effects. Engine-internal. */
  [INVOKE_MECHANIC_ACTION]: (mechanicKey: string, actionKey: string, actor: IPlayerCharacter) => void;
}

/**
 * Construction options for a {@link Campaign}.
 */
export interface CampaignOptions {
  /** Display title of the campaign. */
  title: string;
  /** Round count at which the campaign auto-ends. Defaults to 100. */
  maxRounds?: number;
  /** Recipes the party knows from the start. Defaults to none. */
  knownRecipes?: CraftingRecipe[];
  /** Injected random source for deterministic play; defaults to `Math.random`. */
  rng?: () => number;
  /** Base per-room encounter chance (percent) for the encounter table; defaults to 20. */
  baseEncounterChance?: number;
  /** Default sounds keyed by action kind, filled into action cues lacking a sound. */
  actionSounds?: Partial<Record<ActionKind, AssetRef>>;
  /** Conditions that, when met, resolve the campaign as won. */
  winConditions?: VictoryCondition[];
  /** Conditions that, when met, resolve the campaign as lost. */
  loseConditions?: VictoryCondition[];
  /** Authored prose for a timed-out ending. */
  timeoutNarration?: OutcomeNarration;
  /** Authored prose for a manually-ended campaign. */
  endedNarration?: OutcomeNarration;
  /** Chat configuration (inert engine data; consumed by comms + UI). */
  chatPolicy?: ChatPolicy;
  /** A/V configuration (inert engine data; consumed by comms + UI). */
  avPolicy?: AvPolicy;
  /** Opted-in custom mechanics in authoring order. */
  mechanics?: LiveMechanic[];
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
  #knownRecipes: Map<RecipeId, CraftingRecipe> = new Map();
  #archetypes: Map<ArchetypeId, Archetype> = new Map();
  #started = false;
  #outcome: CampaignOutcome = "ongoing";
  #outcomeReason: string | undefined = undefined;
  #winConditions: VictoryCondition[] = [];
  #loseConditions: VictoryCondition[] = [];
  #timeoutNarration: OutcomeNarration | undefined = undefined;
  #endedNarration: OutcomeNarration | undefined = undefined;
  #activeCharacterIndex: number = 0;
  #actedThisRound: WeakMap<IPlayerCharacter, boolean>;
  #encounterTable: EncounterTable;
  #cueHandlers: Array<(cue: PresentationCue) => void> = [];
  #encountered: Set<string> = new Set<string>();
  #actionSounds: Partial<Record<ActionKind, AssetRef>>;
  #codex = new Codex();
  #chatPolicy: ChatPolicy;
  #avPolicy: AvPolicy;
  #mechanics: LiveMechanic[] = [];
  #rng: () => number = Math.random;

  get round() {
    return this.#round;
  }

  get materials(): Readonly<MaterialMap> {
    return { ...this.#materials };
  }

  get knownRecipes(): ReadonlyMap<RecipeId, CraftingRecipe> {
    // Deliberately the live map (as a ReadonlyMap), not a copy like `materials`:
    // crafting reads it via `.get(id)` on every craft, so a per-access Map copy
    // would be wasteful, and the read-only type is a sufficient boundary. Mutation
    // is funnelled through `discoverRecipe`.
    return this.#knownRecipes;
  }

  get archetypes(): ReadonlyMap<ArchetypeId, Archetype> {
    // Live map exposed as ReadonlyMap, matching knownRecipes: selection reads it
    // via .get(id), so a per-access copy would be wasteful. Mutation is funnelled
    // through registerArchetype.
    return this.#archetypes;
  }

  get codex(): ICodex {
    return this.#codex;
  }

  /** This campaign's chat configuration (inert engine data; consumed by comms + UI). */
  get chatPolicy(): ChatPolicy {
    return this.#chatPolicy;
  }

  /** This campaign's A/V configuration (inert engine data; consumed by comms + UI). */
  get avPolicy(): AvPolicy {
    return this.#avPolicy;
  }

  get started(): boolean {
    return this.#started;
  }

  /** The resolved outcome, or "ongoing" while the campaign is still in play. */
  get outcome(): CampaignOutcome {
    return this.#outcome;
  }

  /** Registry key of the win/loss condition that fired, if any. */
  get outcomeReason(): string | undefined {
    return this.#outcomeReason;
  }

  /**
   * Authored prose for the resolved outcome, available to any play surface
   * whether it listens to the resolution cue or polls. Derived, so a reloaded
   * finished campaign reports the same ending.
   */
  get outcomeNarration(): OutcomeNarration | undefined {
    switch (this.#outcome) {
      case "timed-out":
        return this.#timeoutNarration;
      case "ended":
        return this.#endedNarration;
      case "won":
      case "lost": {
        const list = this.#outcome === "won" ? this.#winConditions : this.#loseConditions;
        return list.find((c) => c.key === this.#outcomeReason)?.narration;
      }
      default:
        return undefined; // ongoing
    }
  }

  /** Whether the campaign has ended (won, lost, timed out, or manually ended). */
  get finished(): boolean {
    return this.#outcome !== "ongoing";
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
    if (this.#outcome !== "ongoing") {
      throw new ProceduralViolation("Campaign has already finished");
    }
  }

  /**
   * Options for constructing a {@link Campaign}.
   */
  constructor({
    title,
    maxRounds = 100,
    knownRecipes = [],
    rng,
    baseEncounterChance,
    actionSounds,
    winConditions,
    loseConditions,
    timeoutNarration,
    endedNarration,
    chatPolicy,
    avPolicy,
    mechanics,
  }: CampaignOptions) {
    this.id = generateId<CampaignId>();
    this.title = title;
    this.party = [];
    this.#round = 0;
    this.#gm = undefined;
    this.maxRounds = maxRounds;

    this.#rng = rng ?? Math.random;
    this.#encounterTable = new EncounterTable({
      rng: this.#rng,
      baseChance: baseEncounterChance ?? 20,
    });

    this.#actedThisRound = new WeakMap<IPlayerCharacter, boolean>();
    this.#resetActivity();

    this.#activeCharacterIndex = 0;

    this.#actionSounds = actionSounds ?? {};
    this.#winConditions = [...(winConditions ?? [])];
    this.#loseConditions = [...(loseConditions ?? [])];
    this.#timeoutNarration = timeoutNarration;
    this.#endedNarration = endedNarration;
    this.#chatPolicy = chatPolicy ?? DEFAULT_CHAT_POLICY;
    this.#avPolicy = avPolicy ?? DEFAULT_AV_POLICY;
    this.#mechanics = [...(mechanics ?? [])];

    for (const recipe of knownRecipes) {
      this.discoverRecipe(recipe);
    }
  }

  /**
   * Starts the campaign, after which the GM can no longer be set directly and
   * turn management becomes available.
   *
   * Archetype handling depends on the catalog: with **none** registered,
   * archetypes are optional and members keep their base stats and slots; with
   * **exactly one** registered, it is auto-selected as the default for any member
   * who hasn't chosen; with **several** registered, every member must have chosen
   * one explicitly.
   *
   * @throws {@link ProceduralViolation} if already started, if the party is
   *   empty, if the GM is not a member of the party, or if archetypes are
   *   registered and a party member has not selected one (and the catalog holds
   *   more than one, so no default can be inferred).
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
    const registered = [...this.#archetypes.values()];
    if (registered.length > 0) {
      // A single registered archetype is the default: auto-select it for any
      // member who hasn't chosen, so authors needn't wire selection by hand.
      if (registered.length === 1) {
        const sole = registered[0]!;
        for (const member of this.party) {
          if (member.archetype === undefined) {
            member.selectArchetype(sole.id);
          }
        }
      }
      // With archetypes on offer, every member must end up with one.
      if (this.party.some((member) => member.archetype === undefined)) {
        throw new ProceduralViolation(
          "Cannot begin a campaign whose party members have not all chosen an archetype",
        );
      }
    }
    this.#started = true;
    this.#dispatchRound("onRoundStart");
  }

  // Centralized termination: set the outcome, record the firing key, and emit a
  // single resolution cue carrying the resolved prose. The only writer of #outcome.
  #finish(outcome: Exclude<CampaignOutcome, "ongoing">, condition?: VictoryCondition): void {
    this.#outcome = outcome;
    this.#outcomeReason = condition?.key;
    this[EMIT_CUE]({
      kind: "resolution",
      outcome,
      reason: condition?.key,
      narration: this.outcomeNarration,
    });
  }

  /**
   * Manually ends a running campaign with the `ended` outcome (a deliberate GM
   * stop, distinct from a win/loss/timeout).
   * @throws {@link ProceduralViolation} if the campaign is not currently running.
   */
  endCampaign() {
    this.#assertRunning();
    this.#finish("ended");
  }

  /**
   * Advances to the next round once every party member has acted, then resolves
   * the campaign against its victory conditions and the maxRounds ceiling.
   *
   * @throws {@link ProceduralViolation} if not running, or if called before all
   *   characters have acted this round.
   */
  endRound() {
    this.#assertRunning();
    const allPartyActed = this.party.every((c) => this.#actedThisRound.get(c));
    if (!allPartyActed) {
      throw new ProceduralViolation(
        "Attempted to end round before all characters have acted",
      );
    }
    this.#dispatchRound("onRoundEnd");
    this.#round = this.#round + 1;
    this.#resetActivity();
    const result = resolveOutcome({
      round: this.#round,
      maxRounds: this.maxRounds,
      winConditions: this.#winConditions,
      loseConditions: this.#loseConditions,
      campaign: this,
    });
    if (result.status !== "ongoing") {
      this.#finish(result.status, result.condition);
      return;
    }
    this.#dispatchRound("onRoundStart");
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
   * @param recipeId - The recipe id to test.
   * @returns Whether the party already knows it.
   */
  knows(recipeId: RecipeId): boolean {
    return this.#knownRecipes.has(recipeId);
  }

  /** Subscribes `handler` to the presentation cue stream. */
  onCue(handler: (cue: PresentationCue) => void) {
    this.#cueHandlers.push(handler);
  }

  /** Removes `handler` from the cue stream; a no-op if it was not subscribed. */
  offCue(handler: (cue: PresentationCue) => void) {
    const index = this.#cueHandlers.indexOf(handler);
    if (index !== -1) {
      this.#cueHandlers.splice(index, 1);
    }
  }

  // Fans a cue out to every subscriber. A throwing handler is isolated so one bad
  // presentation subscriber cannot break the turn loop (the engine has no logger,
  // and a handler failure is not a game-rule violation).
  #dispatch(cue: PresentationCue) {
    for (const handler of [...this.#cueHandlers]) {
      try {
        handler(cue);
      } catch {
        // Intentionally swallowed: presentation is best-effort, never load-bearing.
      }
    }
  }

  #characterView(c: IPlayerCharacter): CharacterView {
    return {
      id: c.id,
      name: c.name,
      health: c.effectiveStat(StatType.Health),
      sanity: c.effectiveStat(StatType.Sanity),
      energy: c.effectiveStat(StatType.Energy),
      status: [...c.status],
      roomId: c.currentRoom?.id,
      // behaviorKey is an item's registry key, set at construction for every
      // registered (non-key) item. Match against it to test registry origin.
      hasEquipped: (key: string) => {
        for (const item of c.equipment.values()) {
          if (item.behaviorKey === key) return true;
        }
        return false;
      },
      hasItem: (key: string) => {
        for (const item of c.inventory.items) {
          if (item.behaviorKey === key) return true;
        }
        return false;
      },
    };
  }

  #campaignView(): CampaignView {
    return {
      round: this.#round,
      maxRounds: this.maxRounds,
      party: this.party.map((p) => this.#characterView(p)),
      rooms: [],
    };
  }

  #hookCtx(m: LiveMechanic): HookCtx<JsonObject> {
    const view = this.#campaignView();
    return { state: m.state, view, rng: this.#rng, roll: (n) => roll(n, this.#rng) };
  }

  #dispatchRound(hook: "onRoundStart" | "onRoundEnd"): void {
    if (this.#mechanics.length === 0) return;
    runReducers(
      this.#mechanics,
      (m) => m.mechanic[hook]?.(this.#hookCtx(m)),
      (e) => applyEffect(this, e),
    );
  }

  [DISPATCH_TURN](phase: "start" | "end", actor: IPlayerCharacter): void {
    if (this.#mechanics.length === 0) return;
    const hook = phase === "start" ? "onTurnStart" : "onTurnEnd";
    const actorView = this.#characterView(actor);
    runReducers(
      this.#mechanics,
      (m) => m.mechanic[hook]?.({ ...this.#hookCtx(m), actor: actorView }),
      (e) => applyEffect(this, e),
    );
  }

  [DISPATCH_ACTION](detail: ActionDetail, actor: IPlayerCharacter): void {
    if (this.#mechanics.length === 0) return;
    const actorView = this.#characterView(actor);
    runReducers(
      this.#mechanics,
      (m) => m.mechanic.onAction?.({ ...this.#hookCtx(m), actor: actorView, action: detail }),
      (e) => applyEffect(this, e),
    );
  }

  [TRANSFORM_DAMAGE](dv: DamageView): number {
    if (this.#mechanics.length === 0) return dv.amount;
    return runDamageTransformers(
      this.#mechanics,
      dv,
      (m) => this.#hookCtx(m),
      (key, value) => this[EMIT_CUE]({ kind: "mechanic", cue: { text: `${key} fixed damage at ${value}.` } }),
    );
  }

  [INVOKE_MECHANIC_ACTION](mechanicKey: string, actionKey: string, actor: IPlayerCharacter): void {
    const m = this.#mechanics.find((x) => x.key === mechanicKey);
    if (!m) throw new ProceduralViolation(`Mechanic '${mechanicKey}' is not enabled.`);
    const action = m.mechanic.actions?.[actionKey];
    if (!action) throw new ProceduralViolation(`Mechanic '${mechanicKey}' has no action '${actionKey}'.`);
    const ctx = {
      ...this.#hookCtx(m),
      actor: this.#characterView(actor),
      action: { kind: "mechanicAction" as const, mechanic: mechanicKey, action: actionKey },
    };
    const effects = action.run(ctx) ?? [];
    if (effects.length > MAX_EFFECTS_PER_EVENT) {
      throw new ProceduralViolation(`Mechanic action '${mechanicKey}.${actionKey}' emitted too many effects.`);
    }
    for (const e of effects) applyEffect(this, e);
  }

  /**
   * Mechanics seam: resolve a party member by id. Throws {@link ProceduralViolation}
   * if no party member with that id is found. Unforgeable (symbol-keyed).
   */
  [FIND_CHARACTER](id: CharacterId): IPlayerCharacter {
    const c = this.party.find((p) => p.id === id);
    if (!c) throw new ProceduralViolation(`No party character for id '${id}'.`);
    return c;
  }

  /**
   * Mechanics seam: resolve ANY character by id — party members plus non-party
   * occupants (NPCs, mobs) reachable from the party's rooms. Unlike
   * {@link FIND_CHARACTER} (party-only, throwing), this reaches non-party
   * characters and returns `undefined` when none matches, so callers decide
   * whether an absence is an error. Mirrors the serializer's party+occupants BFS
   * (the exact set the Rust core's flat `World.characters` holds); used by the
   * `GiveItem`/`SetVisible` effects, which are not party-restricted. Unforgeable.
   */
  [FIND_ANY_CHARACTER](id: CharacterId): ICharacter | undefined {
    const partyMember = this.party.find((p) => p.id === id);
    if (partyMember) return partyMember;
    // BFS over rooms reachable from any party member's current room, scanning
    // each room's (raw, incl. invisible) occupants — matches serializer.ts.
    const seenRooms = new Set<string>();
    const queue: IRoom[] = [];
    const enqueue = (r: IRoom) => {
      if (!seenRooms.has(r.id)) {
        seenRooms.add(r.id);
        queue.push(r);
      }
    };
    for (const p of this.party) if (p.currentRoom) enqueue(p.currentRoom);
    while (queue.length) {
      const r = queue.shift()!;
      for (const occ of r.occupants) if (occ.id === id) return occ;
      for (const [, exit] of r.exits) enqueue(exit.otherSide(r));
    }
    return undefined;
  }

  /**
   * Publishes a cue to subscribers. For an action cue with no resolved sound,
   * fills in the campaign default for that action kind. Engine-internal.
   */
  [EMIT_CUE](cue: PresentationCue) {
    const finalCue: PresentationCue =
      cue.kind === "action" && cue.sound === undefined
        ? { ...cue, sound: this.#actionSounds[cue.action] }
        : cue;
    this.#dispatch(finalCue);
  }

  /**
   * Scans `room` (which `character` just entered) and emits one `encounter` cue
   * per active (non-KO), non-party occupant the character has not encountered
   * before. Dedup is per (characterId, mobId), so re-entry — or the mob leaving
   * and returning — never replays the cue for that character. Engine-internal.
   */
  [NOTE_ENCOUNTERS](character: ICharacter, room: IRoom) {
    const partyIds = new Set(this.party.map((p) => p.id));
    for (const occupant of room.occupants) {
      if (partyIds.has(occupant.id)) continue;
      if (occupant.status.includes(Status.KO)) continue;
      const key = `${character.id}:${occupant.id}`;
      if (this.#encountered.has(key)) continue;
      this.#encountered.add(key);
      this.#dispatch({
        kind: "encounter",
        mob: { id: occupant.id, name: occupant.name },
        room: { id: room.id, name: room.name },
        sound: occupant.presentation?.sound,
      });
      this[RECORD_ENCOUNTER]({ kind: "mob", mob: occupant }, character, room);
    }
  }

  /**
   * Records a party encounter into the codex. Ignored when `by` is a character
   * that is not a current party member, so only party encounters are tracked.
   * `by === undefined` is a party-level attribution (e.g. a mob material drop
   * with no resolvable defeater). Engine-internal; first-write-wins per kind/key.
   */
  [RECORD_ENCOUNTER](
    event: CodexEncounterEvent,
    by: ICharacter | undefined,
    where: IRoom | null,
  ) {
    if (by !== undefined && !this.party.some((p) => p.id === by.id)) {
      return;
    }
    this.#codex.record(event, {
      round: this.#round,
      characterId: by?.id,
      roomId: where?.id,
    });
  }

  /**
   * Marks `recipe` known to the whole party. Idempotent by id: the first
   * definition for an id wins; later calls with that id are ignored.
   *
   * @param recipe - The recipe to learn.
   */
  discoverRecipe(recipe: CraftingRecipe, discoveredBy?: ICharacter) {
    if (this.#knownRecipes.has(recipe.id)) {
      return;
    }
    this.#knownRecipes.set(recipe.id, recipe);
    this[RECORD_ENCOUNTER](
      { kind: "recipe", recipe },
      discoveredBy,
      discoveredBy?.currentRoom ?? null,
    );
  }

  /**
   * Registers an archetype in the campaign catalog. Idempotent by id: the first
   * definition for an id wins; later calls with that id are ignored.
   *
   * @param archetype - The archetype to register.
   */
  registerArchetype(archetype: Archetype) {
    if (this.#archetypes.has(archetype.id)) {
      return;
    }
    this.#archetypes.set(archetype.id, archetype);
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

  /**
   * Registers a roving {@link Formation}. Delegates to the encounter table,
   * which rejects formations whose mobs carry key-item drops.
   */
  addFormation(formation: Formation) {
    this.#encounterTable.addFormation(formation, this);
  }

  /**
   * Runs the encounter spawn check for a player entering `room` (first-visit
   * only, suppressed when an active mob is present).
   *
   * @returns The mobs spawned, if any.
   */
  maybeSpawn(room: IRoom): IMob[] {
    return this.#encounterTable.maybeSpawn(room, this);
  }

  /**
   * Emits a plain-data snapshot of all campaign-level state. References to
   * entities (party, gm, characters that acted) are captured by id; the rng and
   * cue handlers are runtime-only and deliberately omitted. Engine-internal seam.
   */
  [SERIALIZE](): CampaignCoreSnapshot {
    return {
      id: this.id,
      title: this.title,
      maxRounds: this.maxRounds,
      round: this.#round,
      started: this.#started,
      outcome: this.#outcome,
      outcomeReason: this.#outcomeReason,
      winConditions: this.#winConditions.map((c) => ({ key: c.key, narration: c.narration })),
      loseConditions: this.#loseConditions.map((c) => ({ key: c.key, narration: c.narration })),
      timeoutNarration: this.#timeoutNarration,
      endedNarration: this.#endedNarration,
      activeCharacterIndex: this.#activeCharacterIndex,
      partyIds: this.party.map((p) => p.id),
      actedThisRound: this.party
        .filter((p) => this.#actedThisRound.get(p))
        .map((p) => p.id),
      gmId: this.#gm?.id ?? null,
      materials: { ...this.#materials },
      claims: [...this.#claims],
      encountered: [...this.#encountered],
      knownRecipes: [...this.#knownRecipes.keys()],
      archetypes: [...this.#archetypes.values()].map((a) => ({ ...a })),
      actionSounds: { ...this.#actionSounds },
      encounterTable: this.#encounterTable[SERIALIZE](),
      chatPolicy: { ...this.#chatPolicy },
      avPolicy: { ...this.#avPolicy },
      mechanics: this.#mechanics.map((m) => {
        try {
          return { key: m.key, state: JSON.parse(JSON.stringify(m.state)) as JsonValue };
        } catch {
          throw new ProceduralViolation(`Mechanic '${m.key}' has non-serializable state.`);
        }
      }),
    };
  }

  /**
   * PASS 1 of campaign hydration: restores the archetype + recipe catalog. Must
   * run before any character `[HYDRATE]`, since `PlayerCharacter.hydrateExtra`
   * resolves its archetype against `campaign.archetypes`. Engine-internal seam.
   */
  [HYDRATE_CATALOG](core: CampaignCoreSnapshot, registry: CampaignRegistry): void {
    this.#archetypes.clear();
    this.#knownRecipes.clear();
    for (const archetype of core.archetypes) {
      this.#archetypes.set(archetype.id, { ...archetype });
    }
    for (const key of core.knownRecipes) {
      const recipe = registry.recipe(key);
      this.#knownRecipes.set(recipe.id, recipe);
    }
    this.#winConditions = core.winConditions.map((c) => ({
      key: c.key,
      test: registry.condition(c.key),
      narration: c.narration,
    }));
    this.#loseConditions = core.loseConditions.map((c) => ({
      key: c.key,
      test: registry.condition(c.key),
      narration: c.narration,
    }));
    this.#timeoutNarration = core.timeoutNarration;
    this.#endedNarration = core.endedNarration;
    this.#mechanics = core.mechanics.map((m) => ({
      key: m.key,
      mechanic: registry.mechanic(m.key), // throws ProceduralViolation if missing
      state: m.state as JsonObject,
    }));
  }

  /**
   * PASS 2 of campaign hydration: restores lifecycle/turn state and wires party,
   * GM, acted-this-round, the encounter table, and per-room shared state. Assumes
   * the catalog is already populated (see {@link Campaign[HYDRATE_CATALOG]}) and
   * all characters are already indexed in `ctx`. Engine-internal seam.
   */
  [HYDRATE](core: CampaignCoreSnapshot, ctx: HydrateContext): void {
    this.#round = core.round;
    this.#started = core.started;
    this.#outcome = core.outcome;
    this.#outcomeReason = core.outcomeReason;
    this.#activeCharacterIndex = core.activeCharacterIndex;
    this.#materials = { ...core.materials };
    this.#claims.clear();
    for (const claim of core.claims) this.#claims.add(claim);
    this.#encountered.clear();
    for (const key of core.encountered) this.#encountered.add(key);
    this.#actionSounds = { ...core.actionSounds };
    this.party.length = 0;
    for (const id of core.partyIds) {
      this.party.push(ctx.character(id) as IPlayerCharacter);
    }
    this.#gm = core.gmId
      ? (ctx.character(core.gmId) as IPlayerCharacter)
      : undefined;
    this.#actedThisRound = new WeakMap<IPlayerCharacter, boolean>();
    for (const id of core.actedThisRound) {
      this.#actedThisRound.set(ctx.character(id) as IPlayerCharacter, true);
    }
    this.#encounterTable[HYDRATE](core.encounterTable, ctx.registry);
    this.#chatPolicy = { ...core.chatPolicy };
    this.#avPolicy = { ...core.avPolicy };
  }

  /**
   * Injects already-built codex entries into the private codex. Threaded
   * separately from {@link Campaign[HYDRATE]} because the entries live on the
   * full snapshot, not on the campaign-core snapshot. Engine-internal seam.
   */
  [HYDRATE_CODEX_ENTRIES](entries: CodexEntry[]): void {
    this.#codex[HYDRATE_CODEX](entries);
  }
}
