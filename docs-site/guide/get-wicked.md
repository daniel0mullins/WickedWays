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
import type { Mechanic, JsonObject } from "./lib/mechanics/mechanic";

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

## 2. A custom mechanic

A [`Mechanic`](/api/mechanics/mechanic/) hooks into the turn loop and the damage
pipeline. "Dread" drains one Sanity from the acting character at the start of
each turn by returning an `adjustStat` effect. (Mechanics can also `modifyDamage`,
react `onAction`, emit cues, and expose custom actions.)

```ts
const dread: Mechanic<JsonObject> = {
  initialState: () => ({}),
  onTurnStart: (h) => [{ kind: "adjustStat", target: h.actor.id, stat: "sanity", delta: -1 }],
};
```

## 3. The registry

`defineRegistry` is the catalog of everything the template refers to by key:
item factories, crafting recipes, scene behaviors (preconditions + script),
encounter formations (mob factories), win/lose conditions, and custom mechanics.
The returned registry is **typed** — the builder compile-checks every key you
pass against it.

```ts
const registry = defineRegistry({
  items: {
    sword: () => makeItem({ behaviorKey: "sword", name: "Iron Sword", type: ItemType.Weapon, recipe: { metal: 2 }, modifier: 6, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 10 }, { equippable: true }),
    torch: () => makeItem({ behaviorKey: "torch", name: "Torch", type: ItemType.Weapon, recipe: { item: 1 }, modifier: 0, stat: StatType.Health, slot: SlotKind.Hand, emitsLight: true }, { equippable: true }),
    salve: () => makeItem({ behaviorKey: "salve", name: "Healing Salve", type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 5, stat: StatType.Health }, { usable: true }),
    "rusty-key": () => createKey({ name: "Rusty Key", keyCode: "vault", consumeOnUse: true }),
  },
  recipes: {
    "forge-blade": {
      id: "forge-blade" as RecipeId,
      materials: { metal: 2 },
      create: () => makeItem({ behaviorKey: "sword", name: "Forged Blade", type: ItemType.Weapon, recipe: { metal: 2 }, modifier: 5, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 5 }, { equippable: true }),
    },
  },
  scenes: {
    whisper: { preconditions: [], script: () => { console.log("  [scene] A cold whisper greets you."); } },
  },
  formations: {
    rats: { build: (campaign: ICampaign): IMob[] => [new Mob({ campaign, name: "Sewer Rat", stats: { [StatType.Health]: 4, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, drops: [] })] },
  },
  npcs: {
    hermit: {
      initialDialogue: "Turn back, delver.",
      // The precondition functions live here, keyed — so they re-bind on hydrate.
      dialogue: [{ type: "exact", trigger: "vault", response: ["The vault lies north, past the crypt."] }],
    },
  },
  conditions: {
    "reached-vault": (c: ICampaign) => c.party.some((p) => p.currentRoom?.name === "Vault"),
    "party-wiped": (c: ICampaign) => c.party.length > 0 && c.party.every((p) => p.status.includes(Status.KO)),
  },
  mechanics: { dread },
});
```

## 4. The template

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
  .archetype({ id: "delver", name: "Delver", baseStats: { [StatType.Health]: 14, [StatType.Sanity]: 20 }, inventorySlots: 6, immunities: [Status.Fear] })
  .room("Entrance", { description: "A damp stone entrance." })
  .room("Crypt", { description: "A pitch-black crypt.", dark: true })
  .room("Vault", { description: "A sealed vault.", spawnModifier: 0 })
  .startRoom("Entrance")
  .exit("Entrance", "north", "Crypt")
  .exit("Crypt", "north", "Vault")
  .exit("Crypt", "south", "Entrance")
  .exit("Vault", "south", "Crypt")
  .loot("chest", { room: "Entrance", items: ["sword", "torch", "salve"], description: "A dusty chest." })
  .cache("ore", { room: "Crypt", materials: { metal: 3 } })
  .materials("starting-stock", { metal: 1 })
  .mob("Gravewight", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 5, [StatType.Energy]: 5 }, room: "Crypt", drops: ["rusty-key"] })
  .npc("Hermit", { stats: stats(), room: "Entrance", behavior: "hermit" })
  .scene("Crypt", "whisper")
  .formation("rats", { weight: 1 })
  .recipe("forge-blade")
  .useMechanic("dread")
  .winWhen("reached-vault", { text: "You breach the vault." })
  .loseWhen("party-wiped", { text: "The party falls." })
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

## 5. Play it — every mechanic in motion

`startSession` assembles the template, seats the players (a player starts at the
baseline stats and is differentiated only by its archetype), sets the GM, and
begins the campaign — returning the live `Campaign`. From there, driving the turn
loop exercises the runtime mechanics: combat, status effects, action gating,
harvesting, crafting, and the win check.

```ts
const campaign = startSession(builder, { players: [{ name: "Ada", archetype: "delver" }], gm: 0 });
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
const crypt = [...entrance.exits.values()].find((r) => r.name === "Crypt")!;
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
const forged = ada.craft("forge-blade" as RecipeId);
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
ada.move([...crypt.exits.values()].find((r) => r.name === "Vault")!); // Crypt → Vault
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
