# Get Wicked

This is the **canonical pattern for authoring a Wicked Ways campaign**: describe
the whole world declaratively with `defineRegistry` + `authorTemplate`, then hand
the template to `startSession` to get a live, ready-to-play [`Campaign`](/api/campaign/).
Everything an author needs — rooms, exits, loot, mobs, NPCs, scenes, encounters,
crafting, custom mechanics, win/lose conditions — is expressed through the fluent
builder. Prefer this over constructing `Campaign`/`Room`/`Item` by hand; the
builder validates the whole description up front and fails with a single
`AuthoringError` listing every problem.

The example below is **one runnable file** that authors a tiny delve and then
plays through it, exercising *every* engine mechanic at least once. Create it at
`src/get-wicked.ts`, paste the sections in order, then compile and run as the
[Getting Started](./getting-started) guide describes:

```bash
pnpm build
node dist/get-wicked.js
```

## 1. Imports and a tiny item factory

Authored items are `() => Item` factories registered by key. A full `Item` takes
four parts — a `descriptor` (what the item *is*), its mutable `properties`, its
`actions` (behaviour), and `events` (hooks). This helper fills in only the
repetitive boilerplate (no-op behaviour + standard flags), so each item still
spells out its own descriptor — including its `recipe` (the item's **material
makeup**: what it yields when destroyed and what crafting consumes) and its
`behaviorKey` (so the world can serialize). Real items wire up actual `actions`
and `events`.

```ts
import { defineRegistry } from "./lib/authoring/registry";
import { authorTemplate } from "./lib/authoring/template-builder";
import { startSession } from "./lib/authoring/orchestration";
import { Item, ItemType, createKey, type ItemDescriptor } from "./lib/inventory";
import { StatType } from "./lib/character/stats";
import { SlotKind } from "./lib/equipment";
import { Status } from "./lib/status";
import { Mob, type IMob } from "./lib/character/mob";
import type { ICampaign } from "./lib/campaign";
import type { RecipeId } from "./lib/crafting";
import type { INonPlayerCharacter } from "./lib/character/non-player-character";
import { EffectKind, type Mechanic, type JsonObject } from "./lib/mechanics/mechanic";

const noop = () => {};

function makeItem(descriptor: ItemDescriptor, props: { equippable?: boolean; usable?: boolean } = {}): Item {
  return new Item({
    descriptor,
    properties: { equippable: props.equippable ?? false, equipped: false, destroyable: true, usable: props.usable ?? false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}
```

## 2. Name your strings once

The registry and the template cross-reference each other constantly by string:
the registry defines an item under the key `"sword"`, and the template's `.loot`
and `.mob` refer back to `"sword"`. A typo in either place is a bug. The
convention this guide follows is to keep each family of identifiers in an
`as const` map and reference its members everywhere — one source of truth, and a
mistyped member (`Wicked_Rooms.Crpyt`) is a compile error. Because the maps are
`as const`, their literal values still drive the registry's typed-key checking,
so the builder keeps validating keys for you.

```ts
const Wicked_Rooms = { Entrance: "Entrance", Crypt: "Crypt", Vault: "Vault" } as const;
const Wicked_Items = { Sword: "sword", Torch: "torch", Salve: "salve", Key: "rusty-key" } as const;
const Wicked_Recipes = { ForgeBlade: "forge-blade" } as const;
const Wicked_Scenes = { Whisper: "whisper" } as const;
const Wicked_Formations = { Rats: "rats" } as const;
const Wicked_Npcs = { Hermit: "hermit" } as const;
const Wicked_Conditions = { ReachedVault: "reached-vault", PartyWiped: "party-wiped" } as const;
const Wicked_Mechanics = { Dread: "dread" } as const;
const Wicked_Archetypes = { Delver: "delver" } as const;
```

## 3. A custom mechanic

A [`Mechanic`](/api/mechanics/mechanic/) hooks into the turn loop and the damage
pipeline. "Dread" drains one Sanity from the acting character at the start of
each turn by returning an `adjustStat` effect. (Mechanics can also `modifyDamage`,
react `onAction`, emit cues, and expose custom actions.)

Each hook receives a **context object** describing the event. For `onTurnStart`
it's a [`TurnCtx`](/api/mechanics/mechanic/interfaces/TurnCtx) (named `ctx` below)
carrying:

- `ctx.actor` — a read-only view of the character whose turn is starting (use
  `ctx.actor.id` to target an effect at it);
- `ctx.state` — this mechanic's own persisted state (the value from
  `initialState`), a live reference you may mutate in place across turns;
- `ctx.view` — a read-only view of the campaign;
- `ctx.rng` / `ctx.roll(n)` — the campaign's seeded randomness, so a mechanic's
  rolls stay reproducible.

A hook returns the `Effect[]` it wants applied (or nothing). Both effect
discriminants have named constants: `kind` is an `EffectKind` member, and `stat`
is a `StatType` member (`adjustStat` accepts `Sanity` or `Energy`).

```ts
const dread: Mechanic<JsonObject> = {
  initialState: () => ({}),
  onTurnStart: (ctx) => [{ kind: EffectKind.AdjustStat, target: ctx.actor.id, stat: StatType.Sanity, delta: -1 }],
};
```

## 4. The registry

`defineRegistry` is the catalog of everything the template refers to by key:
item factories, crafting recipes, scene behaviors (preconditions + script),
encounter formations (mob factories), win/lose conditions, and custom mechanics.
The returned registry is **typed** — the builder compile-checks every key you
pass against it.

```ts
const registry = defineRegistry({
  items: {
    [Wicked_Items.Sword]: () => makeItem({ behaviorKey: Wicked_Items.Sword, name: "Iron Sword", type: ItemType.Weapon, recipe: { metal: 2 }, modifier: 6, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 10 }, { equippable: true }),
    [Wicked_Items.Torch]: () => makeItem({ behaviorKey: Wicked_Items.Torch, name: "Torch", type: ItemType.Weapon, recipe: { item: 1 }, modifier: 0, stat: StatType.Health, slot: SlotKind.Hand, emitsLight: true }, { equippable: true }),
    [Wicked_Items.Salve]: () => makeItem({ behaviorKey: Wicked_Items.Salve, name: "Healing Salve", type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 5, stat: StatType.Health }, { usable: true }),
    [Wicked_Items.Key]: () => createKey({ name: "Rusty Key", keyCode: "vault", consumeOnUse: true }),
  },
  recipes: {
    [Wicked_Recipes.ForgeBlade]: {
      id: Wicked_Recipes.ForgeBlade as RecipeId,
      materials: { metal: 2 },
      create: () => makeItem({ behaviorKey: Wicked_Items.Sword, name: "Forged Blade", type: ItemType.Weapon, recipe: { metal: 2 }, modifier: 5, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 5 }, { equippable: true }),
    },
  },
  scenes: {
    [Wicked_Scenes.Whisper]: { preconditions: [], script: () => { console.log("  [scene] A cold whisper greets you."); } },
  },
  formations: {
    [Wicked_Formations.Rats]: { build: (campaign: ICampaign): IMob[] => [new Mob({ campaign, name: "Sewer Rat", stats: { [StatType.Health]: 4, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, drops: [] })] },
  },
  npcs: {
    [Wicked_Npcs.Hermit]: {
      initialDialogue: "Turn back, delver.",
      // The precondition functions live here, keyed — so they re-bind on hydrate.
      dialogue: [{ type: "exact", trigger: "vault", response: ["The vault lies north, past the crypt."] }],
    },
  },
  conditions: {
    [Wicked_Conditions.ReachedVault]: (c: ICampaign) => c.party.some((p) => p.currentRoom?.name === Wicked_Rooms.Vault),
    [Wicked_Conditions.PartyWiped]: (c: ICampaign) => c.party.length > 0 && c.party.every((p) => p.status.includes(Status.KO)),
  },
  mechanics: { [Wicked_Mechanics.Dread]: dread },
});
```

## 5. The template

`authorTemplate(title, registry, opts)` returns the fluent builder. Every method
is ordering-agnostic (forward references to rooms resolve at build time), so the
description reads top-down. This one wires up an archetype, three rooms (one
**dark**), exits, a **loot** chest, a **material cache**, the shared **materials**
pool, a placed **mob**, an **NPC** with dialogue, a **scene**, a roving
**formation**, an unlocked **recipe**, the **Dread** mechanic, and **win/lose/
timeout** outcomes.

```ts
const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });

const builder = authorTemplate("Get Wicked", registry, { maxRounds: 6, baseEncounterChance: 0, rng: () => 0.5 })
  .archetype({ id: Wicked_Archetypes.Delver, name: "Delver", baseStats: { [StatType.Health]: 14, [StatType.Sanity]: 20 }, inventorySlots: 6, immunities: [Status.Fear] })
  .room(Wicked_Rooms.Entrance, { description: "A damp stone entrance." })
  .room(Wicked_Rooms.Crypt, { description: "A pitch-black crypt.", dark: true })
  .room(Wicked_Rooms.Vault, { description: "A sealed vault.", spawnModifier: 0 })
  .startRoom(Wicked_Rooms.Entrance)
  // .exit(from, direction, to) names both rooms explicitly — there is no "current
  // room"; the chain only returns the builder. Exits are one-way, so each link is
  // declared in both directions to allow walking back.
  .exit(Wicked_Rooms.Entrance, "north", Wicked_Rooms.Crypt)
  .exit(Wicked_Rooms.Crypt, "north", Wicked_Rooms.Vault)
  .exit(Wicked_Rooms.Crypt, "south", Wicked_Rooms.Entrance)
  .exit(Wicked_Rooms.Vault, "south", Wicked_Rooms.Crypt)
  .loot("chest", { room: Wicked_Rooms.Entrance, items: [Wicked_Items.Sword, Wicked_Items.Torch, Wicked_Items.Salve], description: "A dusty chest." })
  .cache("ore", { room: Wicked_Rooms.Crypt, materials: { metal: 3 } })
  .materials("starting-stock", { metal: 1 })
  .mob("Gravewight", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 5, [StatType.Energy]: 5 }, room: Wicked_Rooms.Crypt, drops: [Wicked_Items.Key] })
  .npc("Hermit", { stats: stats(), room: Wicked_Rooms.Entrance, behavior: Wicked_Npcs.Hermit })
  .scene(Wicked_Rooms.Crypt, Wicked_Scenes.Whisper)
  .formation(Wicked_Formations.Rats, { weight: 1 })
  .recipe(Wicked_Recipes.ForgeBlade)
  .useMechanic(Wicked_Mechanics.Dread)
  .winWhen(Wicked_Conditions.ReachedVault, { text: "You breach the vault." })
  .loseWhen(Wicked_Conditions.PartyWiped, { text: "The party falls." })
  .onTimeout({ text: "Dawn breaks; the delve is abandoned." });
```

::: tip Scenes, NPCs, and formations are authored too
`.scene`, `.npc`, and `.formation` attach a registered behavior to the world —
a room's scene script, an NPC's dialogue, and a roving encounter — so everything
lives in one place. Each refers to its behavior **by registry key**, which is
also how they survive serialization: the function-valued parts (a scene's script,
an NPC's dialogue preconditions) can't be serialized, so they re-bind from the
registry on hydrate. That keeps authored worlds fully round-trippable.
:::

## 6. Play it — every mechanic in motion

`startSession` assembles the template, seats the players (a player starts at the
baseline stats and is differentiated only by its archetype), sets the GM, and
begins the campaign — returning the live `Campaign`. From there, driving the turn
loop exercises the runtime mechanics: combat, status effects, action gating,
harvesting, crafting, and the win check.

```ts
const campaign = startSession(builder, { players: [{ name: "Ada", archetype: Wicked_Archetypes.Delver }], gm: 0 });
campaign.onCue(() => {}); // the cue stream drives a UI (chat / A-V / mechanic cues)

const ada = campaign.activeCharacter;
const entrance = ada.currentRoom!;

// --- Archetype: baseStats override (Delver: Health 14, Sanity 20) + a passive Fear immunity ---
console.log("archetype -> health:", ada.stats[StatType.Health]);

// --- Dialogue: talk to the NPC seated in the room ---
const hermit = entrance.occupants.find((o) => o.name === "Hermit") as INonPlayerCharacter;
console.log("dialogue:", hermit.dialogue("vault"));

// --- Loot: take everything from the chest ---
const chest = [...entrance.loot.values()][0]!;
const taken = ada.takeFromLootBox(chest, chest.contents.slice());
console.log("looted:", taken.map((i) => i.name));

// --- Equipment: equip the sword and the torch (both Hand-slot items) ---
const sword = ada.inventory.items.find((i) => i.name === "Iron Sword")!;
const torch = ada.inventory.items.find((i) => i.name === "Torch")!;
ada.equip(sword);
ada.equip(torch);

// --- Dark / light: the crypt is dark with no placed light source ---
const crypt = [...entrance.exits.values()].find((r) => r.name === Wicked_Rooms.Crypt)!;
console.log("crypt lit while dark & empty:", crypt.isLit);
ada.startTurn();
ada.move(crypt); // a carried, equipped torch lights the room (and fires its scene)
console.log("crypt lit with a carried torch:", crypt.isLit);

// --- Combat + durability + status effects: fell the Gravewight ---
const wight = crypt.occupants.find((o) => o.name === "Gravewight")!;
for (let i = 0; i < 10 && !wight.status.includes(Status.KO); i++) {
  ada.startTurn(); // resets the action budget (and ticks the Dread mechanic)
  ada.attack(wight); // the equipped sword adds its modifier and wears down
}
console.log("wight status:", wight.status, "sword durability:", sword.durability);

// --- Keys: a room-origin mob drops its key into the room on defeat ---
const dropped = [...crypt.loot.values()].flatMap((l) => l.contents.map((i) => i.name));
console.log("dropped on defeat:", dropped);

// --- Custom mechanic (Dread): each startTurn drained one sanity ---
console.log("sanity after Dread ticks:", ada.stats[StatType.Sanity]);

// --- Material cache: harvest it (one-shot — it depletes) ---
const cache = [...crypt.materials.values()][0]!;
ada.startTurn();
ada.harvest(cache);
console.log("pool after harvest:", campaign.materials, "cache depleted:", cache.depleted);

// --- Crafting: spend pooled materials to forge a blade ---
const forged = ada.craft(Wicked_Recipes.ForgeBlade as RecipeId);
console.log("crafted:", forged?.name);

// --- Action gating / fizzle: a KO'd character cannot act, so the felled
//     wight's attempted attack is blocked (the hard form of a fizzle) ---
let gated = false;
try {
  (wight as unknown as IMob).attack(ada);
} catch {
  gated = true;
}
console.log("KO'd mob's action gated:", gated);
// (Panic blocks non-move actions; Fear blocks moves; Confused causes a
//  probabilistic *fizzle* — a silent no-op — rather than a throw.)

// --- Victory: reach the vault and end the round; the win condition fires ---
ada.startTurn();
ada.move([...crypt.exits.values()].find((r) => r.name === Wicked_Rooms.Vault)!); // Crypt → Vault
campaign.nextPlayer(); // single-player round end → win/lose conditions evaluated
console.log("outcome:", campaign.outcome, "reason:", campaign.outcomeReason, "round:", campaign.round);
```

Running the file prints:

```
archetype -> health: 14
dialogue: [ 'The vault lies north, past the crypt.' ]
looted: [ 'Iron Sword', 'Torch', 'Healing Salve' ]
crypt lit while dark & empty: false
  [scene] A cold whisper greets you.
crypt lit with a carried torch: true
wight status: [ 'ko' ] sword durability: 9
dropped on defeat: [ 'Rusty Key' ]
sanity after Dread ticks: 18
pool after harvest: { metal: 4 } cache depleted: true
crafted: Forged Blade
KO'd mob's action gated: true
outcome: won reason: reached-vault round: 1
```

## Mechanics covered

| Mechanic | Where |
| --- | --- |
| Archetypes (base stats, slots, immunities) | `.archetype` + `players: [{ archetype }]` |
| Rooms, exits, the map | `.room` / `.exit` / `.startRoom` |
| Dark / light | dark `.room` + a carried `emitsLight` item → `room.isLit` |
| Loot containers | `.loot` + `takeFromLootBox` |
| Equipment & durability | `equip` + the sword's `maxDurability` wearing in combat |
| Combat & mitigation | `attack` (equipped weapon modifier, rock-paper-scissors mitigation) |
| Status effects | the felled wight's `KO` status |
| Action gating / fizzle | a KO'd character's action is blocked |
| Mobs & encounters | `.mob` + `.formation` (roving) + `baseEncounterChance` |
| Keys | `createKey` item dropped by a room-origin mob on defeat |
| Material caches | `.cache` + `harvest` |
| Crafting | `.recipe` + `craft` from the shared pool |
| Scenes | `.scene` firing on room entry |
| Dialogue / NPCs | `.npc` + `npc.dialogue(prompt)` |
| Custom mechanics | `.useMechanic` + a `Mechanic` with `onTurnStart` |
| Victory / lose / timeout | `.winWhen` / `.loseWhen` / `.onTimeout` → `campaign.outcome` |
| Presentation cues | `campaign.onCue(...)` |

## Next steps

- **[Architecture](./architecture)** — the rules each mechanic obeys, in depth.
- **[API Reference](/api/)** — every type used above, generated from the source.
