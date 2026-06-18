import { Campaign } from "../campaign";
import type { ICampaign } from "../campaign";
import type { IItem } from "../inventory";
import { Room } from "../room";
import type { IRoom } from "../room";
import { Loot } from "../loot";
import { MaterialCache } from "../material-cache";
import { Character } from "../character/character";
import type { ICharacter } from "../character/character";
import { SERIALIZE } from "./symbols";
import { SCHEMA_VERSION } from "./types";
import type {
  CampaignSnapshot,
  RoomSnapshot,
  CharacterSnapshot,
  ItemSnapshot,
  LootSnapshot,
  MaterialCacheSnapshot,
} from "./types";

/**
 * Produces a complete, JSON-serializable snapshot of an in-play campaign.
 *
 * Per-entity `[SERIALIZE]` calls double as fail-fast validation: an item that
 * lacks a registered `behaviorKey`, etc., throws here rather than producing an
 * unrestorable snapshot.
 *
 * **Room reachability assumption:** rooms are discovered by a BFS from each
 * party member's `currentRoom` across `exits`. A room that no party member
 * occupies and that nothing links to is therefore not captured. For save/load
 * of an in-play campaign this is sufficient (the party's reachable graph is the
 * playable world); a campaign holding orphaned rooms would need a room registry.
 *
 * @param campaign - The campaign to snapshot.
 * @returns A self-contained {@link CampaignSnapshot}.
 */
export function serializeCampaign(campaign: ICampaign): CampaignSnapshot {
  const c = campaign as Campaign;

  const rooms: RoomSnapshot[] = [];
  const characters: CharacterSnapshot[] = [];
  const items: ItemSnapshot[] = [];
  const loot: LootSnapshot[] = [];
  const materialCaches: MaterialCacheSnapshot[] = [];

  const seenItems = new Set<string>();
  const addItem = (item: IItem) => {
    if (seenItems.has(item.id)) return;
    seenItems.add(item.id);
    // Throws if a non-key item lacks a registered behaviorKey (fail-fast).
    items.push(item[SERIALIZE]());
  };

  // Collect every character reachable: party members plus room occupants.
  const allCharacters = new Map<string, ICharacter>();
  for (const p of c.party) allCharacters.set(p.id, p);

  // BFS over rooms reachable from any party member's current room.
  const roomQueue: IRoom[] = [];
  const seenRooms = new Set<string>();
  const enqueueRoom = (r: IRoom) => {
    if (!seenRooms.has(r.id)) {
      seenRooms.add(r.id);
      roomQueue.push(r);
    }
  };
  for (const p of c.party) if (p.currentRoom) enqueueRoom(p.currentRoom);

  while (roomQueue.length) {
    const r = roomQueue.shift()!;
    rooms.push((r as Room)[SERIALIZE]());
    for (const [, dest] of r.exits) enqueueRoom(dest);
    for (const occ of r.occupants) allCharacters.set(occ.id, occ);
    for (const [, box] of r.loot) {
      loot.push((box as Loot)[SERIALIZE]());
      for (const it of box.contents) addItem(it);
    }
    for (const [, cache] of r.materials) {
      materialCaches.push((cache as MaterialCache)[SERIALIZE]());
    }
  }

  // Characters' inventory, keyring, and equipped items.
  for (const ch of allCharacters.values()) {
    characters.push((ch as Character)[SERIALIZE]());
    for (const it of ch.inventory.items) addItem(it);
    for (const k of ch.inventory.keys) addItem(k);
    for (const [, it] of ch.equipment) addItem(it);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    campaign: c[SERIALIZE](),
    rooms,
    characters,
    items,
    loot,
    materialCaches,
    codex: [...c.codex.all],
  };
}
