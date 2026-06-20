import { Campaign } from "../campaign";
import { Room } from "../room";
import { Mob } from "../character/mob";
import { Loot } from "../loot";
import { MaterialCache } from "../material-cache";
import { AuthoringError } from "./errors";
import type { CampaignRegistry } from "../serialization/registry";
import type { Direction } from "../room";
import type { CampaignTemplateDescription } from "./description";

/** Empty exits object; individual exits are wired in via {@link Room.addExit} after construction. */
const NO_EXITS = {} as Record<Direction, Room>;

/**
 * Validates a {@link CampaignTemplateDescription} (collecting ALL problems into
 * one {@link AuthoringError}), then constructs a live player-less, not-begun
 * {@link Campaign} in the engine's required construction order.
 *
 * @returns `{ campaign, rooms }` — the assembled campaign and a name→{@link Room} map
 *   for use by the session orchestrator (e.g. `startSession`).
 * @throws {@link AuthoringError} if any validation problems are found.
 */
export function assemble(
  desc: CampaignTemplateDescription,
  registry: CampaignRegistry,
): { campaign: Campaign; rooms: Map<string, Room> } {
  // ---- Pass 1: validate-all ----
  const problems: string[] = [];

  const roomNames = new Set<string>();
  const dupCheck = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) problems.push(`Duplicate ${kind} name '${n}'.`);
      seen.add(n);
    }
  };

  for (const r of desc.rooms) roomNames.add(r.name);
  dupCheck("room", desc.rooms.map((r) => r.name));
  dupCheck("mob", desc.mobs.map((m) => m.name));
  dupCheck("loot", desc.loot.map((l) => l.name));
  dupCheck("cache", desc.caches.map((c) => c.name));

  const requireRoom = (name: string | undefined, ctx: string) => {
    if (name !== undefined && !roomNames.has(name)) {
      problems.push(`${ctx} references undefined room '${name}'.`);
    }
  };

  if (desc.startRoom !== undefined) requireRoom(desc.startRoom, "startRoom");
  for (const e of desc.exits) {
    requireRoom(e.from, `exit.from`);
    requireRoom(e.to, `exit.to`);
  }
  for (const m of desc.mobs) requireRoom(m.room, `mob '${m.name}'`);
  for (const l of desc.loot) requireRoom(l.room, `loot '${l.name}'`);
  for (const c of desc.caches) requireRoom(c.room, `cache '${c.name}'`);

  // Defensive runtime key guard (compile-time-checked at the builder level):
  const requireItemKey = (k: string, ctx: string) => {
    try {
      registry.item(k);
    } catch {
      problems.push(`${ctx} references unregistered item key '${k}'.`);
    }
  };

  for (const m of desc.mobs) {
    for (const k of m.drops ?? []) requireItemKey(k, `mob '${m.name}' drop`);
  }
  for (const l of desc.loot) {
    for (const k of l.items) requireItemKey(k, `loot '${l.name}' item`);
  }
  for (const r of desc.rooms) {
    for (const k of r.lights ?? []) requireItemKey(k, `room '${r.name}' light`);
  }
  for (const k of desc.recipes) {
    try {
      registry.recipe(k);
    } catch {
      problems.push(`recipe references unregistered recipe key '${k}'.`);
    }
  }

  const requireConditionKey = (k: string, ctx: string) => {
    try {
      registry.condition(k);
    } catch {
      problems.push(`${ctx} references unregistered condition key '${k}'.`);
    }
  };
  for (const c of desc.winConditions) requireConditionKey(c.key, "winWhen");
  for (const c of desc.loseConditions) requireConditionKey(c.key, "loseWhen");

  if (problems.length > 0) throw new AuthoringError(problems);

  // ---- Pass 2: construct in order ----
  const winConditions = desc.winConditions.map((c) => ({
    key: c.key,
    test: registry.condition(c.key),
    narration: c.narration,
  }));
  const loseConditions = desc.loseConditions.map((c) => ({
    key: c.key,
    test: registry.condition(c.key),
    narration: c.narration,
  }));
  const campaign = new Campaign(desc.title, desc.opts.maxRounds ?? 100, [], {
    rng: desc.opts.rng,
    baseEncounterChance: desc.opts.baseEncounterChance,
    winConditions,
    loseConditions,
    timeoutNarration: desc.timeoutNarration,
    endedNarration: desc.endedNarration,
  });

  for (const a of desc.archetypes) {
    campaign.registerArchetype({
      id: a.id as never,
      name: a.name,
      statModifiers: a.statModifiers,
      inventorySlots: a.inventorySlots,
      immunities: a.immunities,
    });
  }

  const caches = new Map<string, MaterialCache>();
  for (const c of desc.caches) {
    caches.set(c.name, new MaterialCache(c.materials));
  }

  const loot = new Map<string, Loot>();
  for (const l of desc.loot) {
    loot.set(l.name, new Loot(l.description ?? l.name, l.items.map((k) => registry.item(k)())));
  }

  const mobs = new Map<string, Mob>();
  for (const m of desc.mobs) {
    mobs.set(
      m.name,
      new Mob(
        campaign,
        m.name,
        m.stats,
        m.inventorySlots ?? 2,
        m.actionsPerRound ?? 2,
        (m.drops ?? []).map((k) => registry.item(k)()),
        {
          baseEscapeChance: m.baseEscapeChance,
          materialDrops: m.materialDrops,
          lightAverse: m.lightAverse,
        },
      ),
    );
  }

  const rooms = new Map<string, Room>();
  for (const r of desc.rooms) {
    const roomLoot = desc.loot.filter((l) => l.room === r.name).map((l) => loot.get(l.name)!);
    const roomCaches = desc.caches.filter((c) => c.room === r.name).map((c) => caches.get(c.name)!);
    const lights = (r.lights ?? []).map((k) => registry.item(k)());
    rooms.set(
      r.name,
      new Room(
        r.name,
        r.description,
        roomLoot,
        NO_EXITS,
        roomCaches,
        r.spawnModifier ?? 1,
        [],
        undefined,
        r.dark ?? false,
        lights,
      ),
    );
  }

  // Wire mobs into their rooms
  for (const m of desc.mobs) {
    if (m.room !== undefined) {
      rooms.get(m.room)!.placeMob(mobs.get(m.name)!);
    }
  }

  // Wire exits
  for (const e of desc.exits) {
    rooms.get(e.from)!.addExit(e.direction, rooms.get(e.to)!);
  }

  // Register recipes
  for (const k of desc.recipes) {
    campaign.discoverRecipe(registry.recipe(k));
  }

  // Deposit materials
  for (const mat of desc.materials) {
    campaign.claimMaterials(mat.source, mat.map);
  }

  return { campaign, rooms };
}
