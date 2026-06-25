import { Campaign } from "../campaign";
import { Room } from "../room";
import { Scene } from "../scene";
import { Mob } from "../character/mob";
import { NonPlayerCharacter } from "../character/non-player-character";
import { Loot } from "../loot";
import { MaterialCache } from "../material-cache";
import { PLACE } from "../inventory";
import { AuthoringError } from "./errors";
import type { CampaignRegistry } from "../serialization/registry";
import type { Direction } from "../room";
import type { CampaignTemplateDescription } from "./description";

/** Empty exits object; individual exits are wired in via {@link Room.addExit} after construction. */
const NO_EXITS = {} as Record<Direction, never>;

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
  dupCheck("npc", desc.npcs.map((n) => n.name));

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
  for (const n of desc.npcs) requireRoom(n.room, `npc '${n.name}'`);
  for (const s of desc.scenes) requireRoom(s.room, `scene '${s.key}'`);

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

  for (const s of desc.scenes) {
    try {
      registry.scene(s.key);
    } catch {
      problems.push(`scene references unregistered scene key '${s.key}'.`);
    }
  }

  for (const f of desc.formations) {
    try {
      registry.formation(f.key);
    } catch {
      problems.push(`formation references unregistered formation key '${f.key}'.`);
    }
  }

  for (const n of desc.npcs) {
    try {
      registry.npc(n.behavior);
    } catch {
      problems.push(`npc '${n.name}' references unregistered npc key '${n.behavior}'.`);
    }
  }

  const seenMech = new Set<string>();
  for (const m of desc.mechanics) {
    if (seenMech.has(m.key)) {
      problems.push(`useMechanic key '${m.key}' is duplicated.`);
    }
    seenMech.add(m.key);
    try {
      registry.mechanic(m.key);
    } catch {
      problems.push(`useMechanic references unregistered mechanic key '${m.key}'.`);
    }
  }

  if (desc.chat !== undefined && desc.chat.backfillWindow < 1) {
    problems.push(`chat.backfillWindow must be >= 1 (got ${desc.chat.backfillWindow}).`);
  }

  if (desc.av !== undefined && desc.av.maxParticipants < 1) {
    problems.push(`av.maxParticipants must be >= 1 (got ${desc.av.maxParticipants}).`);
  }

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
  const mechanics = desc.mechanics.map((m) => {
    const mechanic = registry.mechanic(m.key);
    return { key: m.key, mechanic, state: mechanic.initialState(m.config) };
  });
  const campaign = new Campaign({
    title: desc.title,
    maxRounds: desc.opts.maxRounds ?? 100,
    knownRecipes: [],
    rng: desc.opts.rng,
    baseEncounterChance: desc.opts.baseEncounterChance,
    winConditions,
    loseConditions,
    mechanics,
    timeoutNarration: desc.timeoutNarration,
    endedNarration: desc.endedNarration,
    chatPolicy: desc.chat,
    avPolicy: desc.av,
  });

  for (const a of desc.archetypes) {
    campaign.registerArchetype({
      id: a.id as never,
      name: a.name,
      baseStats: a.baseStats,
      inventorySlots: a.inventorySlots,
      immunities: a.immunities,
    });
  }

  const caches = new Map<string, MaterialCache>();
  for (const c of desc.caches) {
    caches.set(c.name, new MaterialCache({ contents: c.materials }));
  }

  const loot = new Map<string, Loot>();
  for (const l of desc.loot) {
    loot.set(l.name, new Loot({ description: l.description ?? l.name, contents: l.items.map((k) => registry.item(k)()) }));
  }

  const mobs = new Map<string, Mob>();
  for (const m of desc.mobs) {
    mobs.set(
      m.name,
      new Mob({ campaign, name: m.name, stats: m.stats, inventorySlots: m.inventorySlots ?? 2, actionsPerRound: m.actionsPerRound ?? 2, drops: (m.drops ?? []).map((k) => registry.item(k)()), baseEscapeChance: m.baseEscapeChance, materialDrops: m.materialDrops, lightAverse: m.lightAverse }),
    );
  }

  const rooms = new Map<string, Room>();
  for (const r of desc.rooms) {
    const roomLoot = desc.loot.filter((l) => l.room === r.name).map((l) => loot.get(l.name)!);
    const roomCaches = desc.caches.filter((c) => c.room === r.name).map((c) => caches.get(c.name)!);
    const lights = (r.lights ?? []).map((k) => registry.item(k)());
    rooms.set(
      r.name,
      new Room({
        name: r.name,
        description: r.description,
        loot: roomLoot,
        exits: NO_EXITS,
        materials: roomCaches,
        spawnModifier: r.spawnModifier ?? 1,
        dark: r.dark ?? false,
        lightSources: lights,
      }),
    );
  }

  // Wire mobs into their rooms
  for (const m of desc.mobs) {
    if (m.room !== undefined) {
      rooms.get(m.room)!.placeMob(mobs.get(m.name)!);
    }
  }

  // Seat NPCs in their rooms (via PLACE — like mobs, no enter-scene side effects).
  // Dialogue comes from the registered behavior; the key is kept for serialization.
  for (const n of desc.npcs) {
    const behavior = registry.npc(n.behavior);
    const npc = new NonPlayerCharacter({
      campaign,
      name: n.name,
      stats: n.stats,
      initialDialogue: behavior.initialDialogue,
      dialogueBlocks: behavior.dialogue,
      behaviorKey: n.behavior,
    });
    if (n.room !== undefined) {
      npc[PLACE](rooms.get(n.room)!);
    }
  }

  // Opt in roving encounter formations.
  for (const f of desc.formations) {
    campaign.addFormation({ id: f.key, weight: f.weight ?? 1, build: registry.formation(f.key).build });
  }

  // Wire exits — deduplicate by unordered room-pair since templates declare both directions.
  const wired = new Set<string>();
  for (const e of desc.exits) {
    const from = rooms.get(e.from)!;
    const to = rooms.get(e.to)!;
    const pair = [from.id, to.id].sort().join("|");
    if (wired.has(pair)) continue;
    wired.add(pair);
    from.addExit(e.direction, to); // auto-reverse places exit in `to` too
  }

  // Attach scenes (mirrors hydrateScene: behavior + key, default phase "enter").
  for (const s of desc.scenes) {
    const behavior = registry.scene(s.key);
    rooms.get(s.room)!.registerScene(
      new Scene<never>({
        phase: s.phase ?? "enter",
        preconditions: behavior.preconditions,
        script: behavior.script,
        initialState: (s.initialState ?? {}) as never,
        behaviorKey: s.key,
      }),
    );
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
