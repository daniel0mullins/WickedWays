import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { ProceduralViolation } from "wickedways/lib/util";
import { Directions, type Direction, type IRoom } from "wickedways/lib/room";
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
import type { LockedDoor } from "../campaign/content.js";

const REVERSE: Record<string, Direction> = {
  [Directions.North]: Directions.South,
  [Directions.South]: Directions.North,
  [Directions.East]: Directions.West,
  [Directions.West]: Directions.East,
  [Directions.Northeast]: Directions.Southwest,
  [Directions.Southwest]: Directions.Northeast,
  [Directions.Northwest]: Directions.Southeast,
  [Directions.Southeast]: Directions.Northwest,
};

export interface ExecuteResult { cues: PresentationCue[]; error?: string; }

export interface SessionOptions {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  doors: LockedDoor[];
  aliases: Record<string, string[]>;
  playerName: string;
  archetype?: string;
  saveStore: SaveStore;
  now: () => number;          // injected clock (no ambient Date.now)
  rng?: () => number;
}

export class GameSession {
  private campaign!: Campaign;
  private rooms!: Map<string, IRoom>;
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
    this.rooms = rooms;
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

  // Re-derive the rooms map after restore by walking exits from every party room.
  // Disconnected rooms that were never unlocked stay disconnected on restore,
  // which is correct: their unlocked state lives in room.exits and was serialized.
  private reindexRooms(): void {
    const map = new Map<string, IRoom>();
    const seen = new Set<string>();
    const queue: IRoom[] = [];
    for (const p of this.campaign.party) {
      const r = p.currentRoom;
      if (r) queue.push(r);
    }
    while (queue.length > 0) {
      const r = queue.shift()!;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      map.set(r.name, r);
      for (const next of r.exits.values()) queue.push(next);
    }
    this.rooms = map;
  }

  view(): ViewModel {
    return view(this.campaign, this.opts.doors, this.opts.aliases, this.opened);
  }

  get finished(): boolean { return this.campaign.finished; }
  get outcome(): string { return this.campaign.outcome; }

  execute(intent: Intent): ExecuteResult {
    this.cueBuffer.length = 0;
    const advances = isTimeAdvancing(intent);
    const pre = advances
      ? serializeCampaign(this.campaign, { rootRooms: this.rooms.values() })
      : null;
    try {
      if (advances) this.campaign.activeCharacter.startTurn();
      this.dispatch(intent);
      if (advances) this.campaign.nextPlayer();
      if (advances && pre !== null) this.undoSnapshot = pre;
      return { cues: [...this.cueBuffer] };
    } catch (e) {
      if (e instanceof ProceduralViolation) {
        return { cues: [...this.cueBuffer], error: e.message };
      }
      throw e;
    }
  }

  private dispatch(intent: Intent): void {
    const pc = this.campaign.activeCharacter;
    const room = pc.currentRoom!;
    switch (intent.kind) {
      case "move": {
        const to = room.exits.get(intent.dir);
        if (!to) throw new ProceduralViolation("You can't go that way.");
        pc.move(to);
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
        const { loot, item } = this.findInOpenedLoot(intent.targetId);
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
        pc.attack(target);
        return;
      }
      case "unlock": {
        this.unlock(intent.doorId);
        return;
      }
      case "talk": {
        // No NPCs in this campaign; dialogue is reserved for future content.
        throw new ProceduralViolation("There's no one here to talk to.");
      }
    }
  }

  private findInOpenedLoot(itemId: string): { loot: ILoot; item: IItem } {
    const room = this.campaign.activeCharacter.currentRoom!;
    for (const loot of room.loot.values()) {
      if (!this.opened.has(loot.id)) continue;
      const item = loot.contents.find((i) => i.id === itemId);
      if (item) return { loot, item };
    }
    throw new ProceduralViolation("You don't see that here.");
  }

  private unlock(doorId: string): void {
    const pc = this.campaign.activeCharacter;
    const door = this.opts.doors.find((d) => d.id === doorId);
    if (!door || pc.currentRoom!.name !== door.from) {
      throw new ProceduralViolation("There's no such door here.");
    }
    if (pc.currentRoom!.exits.has(door.dir)) {
      throw new ProceduralViolation("That way is already open.");
    }
    const key = pc.inventory.keys.find((k) => k.keyCode === door.keyCode);
    if (!key) {
      throw new ProceduralViolation(`The ${door.name} won't budge — you don't have the right key.`);
    }
    const from = this.rooms.get(door.from)!;
    const to = this.rooms.get(door.to)!;
    from.addExit(door.dir, to);
    to.addExit(REVERSE[door.dir]!, from);
    if (door.consume) pc.consumeKey(key);
  }

  async save(slot: string): Promise<void> {
    const snapshot = serializeCampaign(this.campaign, { rootRooms: this.rooms.values() });
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
    this.reindexRooms();
  }
}
