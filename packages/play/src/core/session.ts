import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { ProceduralViolation } from "wickedways/lib/util";
import { Status } from "wickedways/lib/status";
import { Mob } from "wickedways/lib/character/mob";
import { StatType } from "wickedways/lib/character/stats";
import type { Campaign } from "wickedways/lib/campaign";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { ArchetypeId } from "wickedways/lib/archetype";
import type { ILoot } from "wickedways/lib/loot";
import type { IItem } from "wickedways/lib/inventory";
import { isTimeAdvancing, type Intent } from "./intent.js";
import { view, type ViewModel } from "./viewmodel.js";
import type { SaveStore } from "./savestore.js";

/** A single mob-on-player strike, surfaced for typed combat feedback. */
export interface MobAttack { name: string; stat: StatType; amount: number; }

export interface ExecuteResult { cues: PresentationCue[]; error?: string; mobAttacks?: MobAttack[]; }

export interface SessionOptions {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  saveStore: SaveStore;
  now: () => number;          // injected clock (no ambient Date.now)
  rng?: () => number;
}

export class GameSession {
  private campaign!: Campaign;
  private readonly cueBuffer: PresentationCue[] = [];
  private readonly opened = new Set<string>();
  private undoSnapshot: CampaignSnapshot | null = null;

  private constructor(private readonly opts: SessionOptions) {}

  static start(opts: SessionOptions): GameSession {
    const s = new GameSession(opts);
    s.boot(opts.builder);
    return s;
  }

  private boot(builder: TemplateBuilder<string, string>): void {
    const { campaign, rooms } = assemble(builder.description, builder.registry);
    this.campaign = campaign;
    const pc = new PlayerCharacter({ campaign, name: this.opts.playerName });
    pc.joinCampaign();
    if (this.opts.archetype !== undefined) {
      pc.selectArchetype(this.opts.archetype as ArchetypeId);
    }
    pc.move(rooms.get(builder.description.startRoom!)!);
    campaign.gm = pc;
    campaign.beginCampaign();
    campaign.onCue((cue) => this.cueBuffer.push(cue));
  }

  /**
   * Restarts the campaign from scratch: re-boots a fresh world from the same
   * builder (new campaign, PC at the start room, turn 0, full stats, empty
   * inventory) and clears all session-local progress (opened loot, undo). Saved
   * games are untouched. `assemble` rebuilds everything from the immutable
   * description, so re-booting the stored builder is safe.
   */
  restart(): void {
    this.cueBuffer.length = 0;
    this.opened.clear();
    this.undoSnapshot = null;
    this.boot(this.opts.builder);
  }

  view(): ViewModel {
    return view(this.campaign, this.opts.aliases, this.opened);
  }

  /**
   * Reads a held item, returning the cues its lore emits (empty when the item is
   * not held or has no lore). Free and non-time-advancing — reading never spends
   * a turn, consumes the item, or snapshots for undo. Used by `examine`/`read`.
   */
  read(itemId: string): PresentationCue[] {
    const pc = this.campaign.activeCharacter;
    const item = pc.inventory.items.find((i) => i.id === itemId);
    if (!item) return [];
    this.cueBuffer.length = 0;
    pc.read(item);
    return [...this.cueBuffer];
  }

  get finished(): boolean { return this.campaign.finished; }
  get outcome(): string { return this.campaign.outcome; }

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
      const mobAttacks = advances ? this.runMobReactions() : [];
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
        // No NPCs in this campaign; dialogue is reserved for future content.
        throw new ProceduralViolation("There's no one here to talk to.");
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

  async save(slot: string): Promise<void> {
    const snapshot = serializeCampaign(this.campaign);
    await this.opts.saveStore.save(slot, snapshot, this.opts.now());
  }

  async restore(slot: string): Promise<boolean> {
    const snapshot = await this.opts.saveStore.load(slot);
    if (!snapshot) return false;
    this.loadSnapshot(snapshot);
    return true;
  }

  undo(): boolean {
    if (!this.undoSnapshot) return false;
    this.loadSnapshot(this.undoSnapshot);
    this.undoSnapshot = null;
    return true;
  }

  private loadSnapshot(snapshot: CampaignSnapshot): void {
    this.campaign = deserializeCampaign(snapshot, { registry: this.opts.registry, rng: this.opts.rng });
    this.campaign.onCue((cue) => this.cueBuffer.push(cue));
    this.opened.clear();
  }
}
