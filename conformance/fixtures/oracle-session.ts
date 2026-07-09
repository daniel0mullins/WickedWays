/**
 * FROZEN ORACLE COPY of the pre-cutover GameSession orchestration
 * (packages/play-runtime/src/session.ts). The facade differential fixtures use
 * this as the TS oracle; the live GameSession becomes the Rust replica at the
 * cutover. Method bodies are verbatim; boot() additionally captures the
 * PRE-begin genesis (what Authority::new consumes) and pins a deterministic
 * PC id ("player:<name>", the mob-defeat.gen.test.ts convention).
 */
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { ProceduralViolation } from "wickedways/lib/util";
import { Status } from "wickedways/lib/status";
import { Mob } from "wickedways/lib/character/mob";
import { NonPlayerCharacter } from "wickedways/lib/character/non-player-character";
import { StatType } from "wickedways/lib/character/stats";
import { EMIT_CUE } from "wickedways/lib/presentation";
import { SET_NPC_STATE } from "wickedways/lib/inventory";
import { applyEffect } from "wickedways/lib/mechanics/apply";
import { MAX_EFFECTS_PER_EVENT } from "wickedways/lib/mechanics/mechanic";
import { runTalk, description, type NpcScript, type NpcState } from "./npc-matcher.ts";
import type { Campaign } from "wickedways/lib/campaign";
import type { CharacterId } from "wickedways/lib/character/character";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { ILoot } from "wickedways/lib/loot";
import type { IItem } from "wickedways/lib/inventory";
import type { Direction } from "wickedways/lib/room";
import { view } from "./oracle-view.ts";

export interface MobAttack { name: string; stat: StatType; amount: number; }
export interface ExecuteResult { cues: PresentationCue[]; error?: string; mobAttacks?: MobAttack[]; }
export type Intent =
  | { kind: "move"; dir: Direction }
  | { kind: "take"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string }
  | { kind: "attack"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "talk"; npcId: string; prompt?: string }
  | { kind: "wait" };
const TIME_ADVANCING = new Set(["move", "take", "drop", "use", "attack", "wait"]);
export const isTimeAdvancing = (i: Intent): boolean => TIME_ADVANCING.has(i.kind);

export interface OracleArgs {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  /** SINGLE shared seeded closure — also authored into the template's rng. */
  rng: () => number;
  /**
   * The catalog's `behaviors` map (the same object exported to the Rust replica).
   * The `talk`/`examine` paths resolve an NPC's `behaviorKey` here to its
   * `{ family:"npc", script: NpcScript }` entry. Absent → dialogue is a no-op.
   */
  behaviors?: Record<string, { family: string; script?: unknown }>;
}

export class OracleSession {
  campaign!: Campaign;
  genesis!: CampaignSnapshot;          // PRE-begin snapshot (Authority::new input)
  startupCues: PresentationCue[] = []; // captured at boot, before any op
  readonly opened = new Set<string>();
  private readonly cueBuffer: PresentationCue[] = [];
  private undoSnapshot: CampaignSnapshot | null = null;

  constructor(private readonly opts: OracleArgs) {
    const { campaign, rooms } = assemble(opts.builder.description, opts.builder.registry);
    this.campaign = campaign;
    const pc = new PlayerCharacter({ campaign, name: opts.playerName, rng: opts.rng });
    pc.id = `player:${opts.playerName}` as CharacterId; // deterministic (regen-stable goldens)
    pc.joinCampaign();
    if (opts.archetype !== undefined) pc.selectArchetype(opts.archetype as ArchetypeId);
    // Pristine-genesis boot placement: seat the PC WITHOUT firing enter-scenes
    // (`fireScenes = false`) — mirrors GameSession.boot. The start-room enter-scenes
    // are deferred to `campaign.beginCampaign()` below (the shared TS impl), which
    // fires them AFTER the round-0 dispatch; with `onCue` registered first, their
    // cues land in `startupCues`. This order is pinned identically in Rust
    // `begin_campaign` and TS `Campaign.beginCampaign` for differential-gate parity.
    pc.move(rooms.get(opts.builder.description.startRoom!)!, /*fireScenes*/ false);
    campaign.gm = pc;
    // PRE-begin genesis — exactly what GameSession will hand Authority::new.
    this.genesis = serializeCampaign(campaign);
    campaign.onCue((cue) => this.cueBuffer.push(cue));
    campaign.beginCampaign();
    this.startupCues = [...this.cueBuffer];
    this.cueBuffer.length = 0;
  }

  // execute(intent), runMobReactions(), dispatch(intent), findInLoot(itemId):
  // VERBATIM from packages/play-runtime/src/session.ts:116-256 (replace
  // `this.#campaign` with `this.campaign`; keep every string and branch).

  execute(intent: Intent): ExecuteResult {
    this.cueBuffer.length = 0;
    const advances = isTimeAdvancing(intent);
    // No rootRooms needed: locked doors are now always-present shared Exits,
    // so the room graph is fully connected and the party-rooted BFS reaches every room.
    const pre = advances
      ? serializeCampaign(this.campaign)
      : null;
    try {
      if (advances) this.campaign.activeCharacter.startTurn();
      this.dispatch(intent);
      // Solo GM: after a time-advancing action, live mobs sharing the player's
      // room strike back. Runs before nextPlayer so a fatal blow is caught by the
      // round's outcome check, and within the `pre` snapshot so undo reverts it too.
      // Light-tied initiative (v1): a time-advancing MOVE into a LIT room does not
      // provoke a reaction — a player who can see gets the drop on entry. Mirrors
      // the Rust World::submit gate (spec:
      // docs/superpowers/specs/2026-07-07-light-tied-mob-initiative-design.md).
      // dispatch() above has already moved the PC, so currentRoom is the destination.
      const enteredLit =
        intent.kind === "move" && (this.campaign.activeCharacter.currentRoom?.isLit ?? false);
      const mobAttacks = advances && !enteredLit ? this.runMobReactions() : [];
      if (advances) this.campaign.nextPlayer();
      if (advances && pre !== null) this.undoSnapshot = pre;
      return { cues: [...this.cueBuffer], mobAttacks };
    } catch (e) {
      if (e instanceof ProceduralViolation) {
        return { cues: [...this.cueBuffer], error: e.message };
      }
      throw e;
    }
  }

  /**
   * Each live (non-KO) mob in the active player's current room attacks the player
   * (the "aggro while sharing its room" rule). Returns the typed damage each dealt,
   * derived from the player's effective-stat deltas. A mob that can't act (afflicted)
   * simply doesn't strike; a downed player is not piled on.
   */
  private runMobReactions(): MobAttack[] {
    const pc = this.campaign.activeCharacter;
    const room = pc.currentRoom;
    const attacks: MobAttack[] = [];
    if (!room || pc.status.includes(Status.KO)) return attacks;

    const stats = (): Record<StatType, number> => ({
      [StatType.Health]: pc.effectiveStat(StatType.Health),
      [StatType.Sanity]: pc.effectiveStat(StatType.Sanity),
      [StatType.Energy]: pc.effectiveStat(StatType.Energy),
    });

    for (const occ of [...room.occupants]) {
      if (occ.id === pc.id || !(occ instanceof Mob) || occ.status.includes(Status.KO)) continue;
      const before = stats();
      try {
        occ.attack(pc);
      } catch (e) {
        if (e instanceof ProceduralViolation) continue; // afflicted/blocked mob can't strike
        throw e;
      }
      const after = stats();
      for (const stat of [StatType.Health, StatType.Sanity, StatType.Energy]) {
        const dealt = before[stat] - after[stat];
        if (dealt > 0) attacks.push({ name: occ.name, stat, amount: dealt });
      }
      if (pc.status.includes(Status.KO)) break; // don't pile on a downed player
    }
    return attacks;
  }

  private dispatch(intent: Intent): void {
    const pc = this.campaign.activeCharacter;
    const room = pc.currentRoom!;
    switch (intent.kind) {
      case "move": {
        pc.go(intent.dir);
        return;
      }
      case "wait":
        return;
      case "open": {
        const loot = [...room.loot.values()].find((l) => l.id === intent.targetId);
        if (!loot) throw new ProceduralViolation("There's nothing like that to open here.");
        pc.openLootBox(loot);
        this.opened.add(loot.id);
        return;
      }
      case "take": {
        const { loot, item } = this.findInLoot(intent.targetId);
        if (!this.opened.has(loot.id)) {
          pc.openLootBox(loot);
          this.opened.add(loot.id);
        }
        pc.takeFromLootBox(loot, [item]);
        return;
      }
      case "drop": {
        const item = pc.inventory.items.find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("You aren't carrying that.");
        // Required quest items (droppable === false) can't be set down.
        if (item.properties.droppable === false) {
          throw new ProceduralViolation(`You can't bring yourself to part with the ${item.name}.`);
        }
        pc.removeFromInventory([item]);
        return;
      }
      case "equip": {
        const item = pc.inventory.items.find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("You aren't carrying that.");
        pc.equip(item);
        return;
      }
      case "unequip": {
        const item = [...pc.equipment.values()].find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("That isn't equipped.");
        pc.unequip(item);
        return;
      }
      case "use": {
        const item = pc.inventory.items.find((i) => i.id === intent.targetId);
        if (!item) throw new ProceduralViolation("You aren't carrying that.");
        item.actions.use(pc);
        return;
      }
      case "attack": {
        const target = room.occupants.find((o) => o.id === intent.targetId);
        if (!target) throw new ProceduralViolation("There's nothing like that to attack here.");
        if (target.status.includes(Status.KO)) {
          throw new ProceduralViolation(`The ${target.name} is already dead.`);
        }
        pc.attack(target);
        return;
      }
      case "talk": {
        // Resolve the target against the current room: it must be a co-located,
        // VISIBLE NonPlayerCharacter. Anything else (missing id, a Mob/player, or
        // a hidden NPC) is "no one to talk to".
        const npc = room.occupants.find((o) => o.id === intent.npcId);
        if (!(npc instanceof NonPlayerCharacter) || !npc.visible) {
          throw new ProceduralViolation("There's no one here to talk to.");
        }
        // Resolve the NPC's dialogue behavior: no key, or a key that doesn't bind
        // an `npc` behavior, is a quiet no-op (mirrors Rust `talk`'s fallbacks and
        // `read_item`'s not-held no-op).
        const key = npc.behaviorKey;
        if (key === undefined) return;
        const behavior = this.opts.behaviors?.[key];
        if (behavior === undefined || behavior.family !== "npc") return;
        const { cue, effects, nextState } = runTalk(
          behavior.script as NpcScript,
          intent.prompt,
          npc.npcState as NpcState,
          pc.id,
        );
        // The `once` latch is written on SELECTION (inside run_talk), BEFORE the
        // effect-cap check — matching Rust (run_talk mutates state, then submit
        // caps and only then pushes the cue).
        npc[SET_NPC_STATE](nextState);
        if (effects.length > MAX_EFFECTS_PER_EVENT) {
          throw new ProceduralViolation(`NPC '${key}' emitted too many effects.`);
        }
        // Response cue first (the NPC "speaks"), then the scripted effects (which
        // may push their own cues via applyEffect).
        this.campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: cue.text } });
        for (const e of effects) applyEffect(this.campaign, e);
        return;
      }
    }
  }

  private findInLoot(itemId: string): { loot: ILoot; item: IItem } {
    const room = this.campaign.activeCharacter.currentRoom!;
    for (const loot of room.loot.values()) {
      const item = loot.contents.find((i) => i.id === itemId);
      if (item) return { loot, item };
    }
    throw new ProceduralViolation("You don't see that here.");
  }

  read(itemId: string): PresentationCue[] {
    // VERBATIM from session.ts:104-111.
    const pc = this.campaign.activeCharacter;
    const item = pc.inventory.items.find((i) => i.id === itemId);
    if (!item) return [];
    this.cueBuffer.length = 0;
    pc.read(item);
    return [...this.cueBuffer];
  }

  examine(npcId: string): PresentationCue[] {
    // FREE + non-advancing (mirrors Rust `World::examine`). A co-located, VISIBLE
    // NPC whose behaviorKey resolves to an `npc` behavior emits its description as
    // a `mechanic` cue (the SAME cue shape as `read`'s lore). Anything else — a
    // non-NPC, hidden, missing, or unresolved-key target — is a quiet no-op ([]).
    const pc = this.campaign.activeCharacter;
    const npc = pc.currentRoom?.occupants.find((o) => o.id === npcId);
    if (!(npc instanceof NonPlayerCharacter) || !npc.visible) return [];
    const key = npc.behaviorKey;
    if (key === undefined) return [];
    const behavior = this.opts.behaviors?.[key];
    if (behavior === undefined || behavior.family !== "npc") return [];
    this.cueBuffer.length = 0;
    this.campaign[EMIT_CUE]({
      kind: "mechanic",
      cue: { text: description(behavior.script as NpcScript) },
    });
    return [...this.cueBuffer];
  }

  undo(): boolean {
    // VERBATIM semantics from session.ts:270-281.
    if (!this.undoSnapshot) return false;
    this.loadSnapshot(this.undoSnapshot);
    this.undoSnapshot = null;
    return true;
  }

  snapshot(): CampaignSnapshot { return serializeCampaign(this.campaign); }
  view() { return view(this.campaign, this.opts.aliases, this.opened); }

  private loadSnapshot(snapshot: CampaignSnapshot): void {
    // VERBATIM from session.ts:277-281 — same rng closure continues its stream
    // (mirrors Authority::restore keeping the advancing Rng).
    this.campaign = deserializeCampaign(snapshot, { registry: this.opts.registry, rng: this.opts.rng });
    this.campaign.onCue((cue) => this.cueBuffer.push(cue));
    this.opened.clear();
  }
}
