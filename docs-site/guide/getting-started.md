# Getting Started

This guide walks you from a fresh checkout to a running campaign: you'll build
a tiny two-character party, start the turn loop, advance a few rounds, and read
the result back out. Every step below is a real code block — paste them in order
and you'll have a complete, runnable example by the end.

If you'd rather skim the concepts first, read the [Introduction](./introduction);
for the full rules, see [Architecture](./architecture).

## Prerequisites

You need [Node.js](https://nodejs.org) (18+) and [pnpm](https://pnpm.io). There
is **no published npm package yet** — you work inside a checkout of the repo and
import directly from the engine source under `src/lib/...` (there is intentionally
no barrel export).

Clone the repo and install dependencies:

```bash
git clone https://github.com/daniel0mullins/WickedWays.git
cd WickedWays
pnpm install
```

There's no separate runner to install: you compile the engine with `pnpm build`
and execute the output with `node`. Create a file at
`src/getting-started-example.ts` and build it up step by step — the final step
shows how to compile and run it.

## Step 1 — Create the campaign

A campaign needs only a title. Pass `maxRounds` to make it end on its own, and
inject a seeded `rng` so the run is fully reproducible — **all** engine
randomness flows through this function, so a fixed seed means identical results
every time. (Omit it and it defaults to `Math.random`.) The campaign mints its
own branded `id` internally; you never pass one in.

Each step's code block opens with the imports it introduces; relative engine
imports omit the file extension, matching the rest of the source tree.

```ts
import { Campaign } from "./lib/campaign";

// A small deterministic PRNG (mulberry32) so the example is reproducible.
function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const campaign = new Campaign({ title: "Wicked Ways", maxRounds: 3, rng: makeRng(42) });
```

## Step 2 — Create the party

A `PlayerCharacter` takes the campaign it belongs to and a display name. Every
player character starts at the same baseline stat block (Health, Sanity, and
Energy all at 10). Call `joinCampaign()` to add each one to the party (it's
idempotent), then nominate one as the Game Master via `campaign.gm`.

```ts
import { PlayerCharacter } from "./lib/character/player-character";

const hero = new PlayerCharacter({ campaign, name: "Hero" });
const seer = new PlayerCharacter({ campaign, name: "Seer" });

hero.joinCampaign();
seer.joinCampaign();

campaign.gm = hero; // the GM must be a party member, and set before the campaign starts
```

The only way to start a character with different stats is to give it an
**archetype** — an authored role that sets stats, adjusts inventory slots, and
grants status immunities. Archetypes are **optional**: skip the rest of this step
and everyone stays on the baseline. Once you *do* register archetypes the engine
expects the party to use them — register **one** and it's auto-selected as
everyone's default; register **several** and each character must choose explicitly
before the campaign can begin. Here we register a single no-op "Neutral" archetype
and select it for both characters (with one archetype the `selectArchetype` calls
are optional, but selecting keeps the flow explicit).

```ts
import type { Archetype, ArchetypeId } from "./lib/archetype";

const neutral: Archetype = {
  id: "neutral" as ArchetypeId, // cast the string literal to the branded id at the boundary
  name: "Neutral",
};

campaign.registerArchetype(neutral);
hero.selectArchetype(neutral.id);
seer.selectArchetype(neutral.id);
```

::: warning Archetype selection is once-only and pre-start
`selectArchetype` throws a `ProceduralViolation` if you call it twice on the same
character or after `beginCampaign()`. If you want one, choose before you start.
:::

## Step 3 — Build a couple of rooms

Rooms are nodes in the dungeon graph, connected by directional exits. Both the
`exits` and `loot` arguments are optional, so the entrance is created bare and
wired up afterwards. A room can be authored with loot containers up front (the
vault gets a chest in its constructor) or have them added later with `addLoot`.
(If you'd rather generate a connected map from a pile of roomless rooms,
`buildMap` wires them for you — and throws if a room can't be reached.)

```ts
import { Directions, Room } from "./lib/room";
import { Loot } from "./lib/loot";
import { Item, ItemType, type ItemDescriptor } from "./lib/inventory";
import { StatType } from "./lib/character/stats";

// A compact factory for a basic item. A real item also wires up its action
// behaviour (equip, use, …) and event hooks; those are no-ops here.
function makeItem(name: string, type: ItemDescriptor["type"], modifier: number): Item {
  const noop = () => {};
  return new Item({
    descriptor: { type, recipe: { metal: 1 }, modifier, stat: StatType.Health, name },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

// A chest the vault holds from the start.
const vaultChest = new Loot({
  description: "A locked iron chest.",
  contents: [makeItem("Iron Sword", ItemType.Weapon, 3)],
});

const entrance = new Room({ name: "Entrance", description: "A damp stone entrance." });
const vault = new Room({ name: "Vault", description: "A sealed vault.", loot: [vaultChest] });

entrance.addExit(Directions.North, vault);
vault.addExit(Directions.South, entrance);

// Loot can also be dropped into a room after it's built.
const supplyCrate = new Loot({
  description: "A dusty supply crate.",
  contents: [makeItem("Healing Salve", ItemType.Consumable, 5)],
});
entrance.addLoot(supplyCrate);
```

(Keys are the exception — they go on the keyring, not in loot, so `Loot` rejects
them; build keys with `createKey` and add them to a character instead.)

## Step 4 — Start the campaign

With a non-empty party and a GM drawn from it, `beginCampaign()` opens the turn
loop. It throws a `ProceduralViolation` if the party is empty or the GM isn't a
member — and, when several archetypes are registered, if a member still hasn't
chosen one. Once started, seed your characters into a room with `move`.

```ts
campaign.beginCampaign();

hero.move(entrance);
seer.move(entrance);
```

## Step 5 — Drive the turn loop

Each turn, the campaign exposes whose turn it is via `activeCharacter`. Call
`startTurn()` to reset that character's per-round action budget, take an action
(here, walking between the two rooms), then `nextPlayer()` to advance. When the
last player in the round acts, `nextPlayer()` automatically runs `endRound()` —
incrementing the round, checking win/lose conditions, and ending the campaign if
it reaches `maxRounds`.

```ts
while (!campaign.finished) {
  const pc = campaign.activeCharacter;
  const here = pc.currentRoom!;
  const exits = [...here.exits.values()];
  const next = exits[0] ?? here; // walk through the first exit, if any

  pc.startTurn();
  pc.move(next);
  campaign.nextPlayer();
}
```

## Step 6 — Observe the result

The campaign ran itself to completion at `maxRounds`. Log its public top-level
state to inspect the final result (entity-valued properties are rendered as
names/keys to keep the output readable):

```ts
console.log({
  id: campaign.id,
  title: campaign.title,
  round: campaign.round,
  maxRounds: campaign.maxRounds,
  started: campaign.started,
  finished: campaign.finished,
  outcome: campaign.outcome,
  outcomeReason: campaign.outcomeReason,
  outcomeNarration: campaign.outcomeNarration,
  party: campaign.party.map((pc) => pc.name),
  gm: campaign.gm?.name,
  activeCharacter: campaign.activeCharacter.name,
  materials: campaign.materials,
  knownRecipes: [...campaign.knownRecipes.keys()],
  archetypes: [...campaign.archetypes.keys()],
  codex: campaign.codex,
  chatPolicy: campaign.chatPolicy,
  avPolicy: campaign.avPolicy,
});
```

Compile the engine and run the file:

```bash
pnpm build
node dist/getting-started-example.js
```

The log shows `round: 3`, `finished: true`, and `outcome: "timed-out"` (the
campaign hit `maxRounds` with no win/lose condition met), the two party members,
and the `neutral` archetype. Bump `maxRounds` to watch the round count climb; the
seeded `rng` keeps any randomness (dungeon layout, encounter spawns) identical
from one run to the next, so the example stays reproducible.

## Gotchas

These are the lifecycle guards a newcomer hits first. The engine enforces rules
at runtime as well as at compile time — illegal moves throw
`ProceduralViolation` rather than silently corrupting state.

- **Order matters.** Build the party and set the GM *before* `beginCampaign()`;
  if you use archetypes, select them first too. Turn operations (`nextPlayer`,
  and adding a player mid-game) only work on a started campaign; archetype
  selection only works on a campaign that hasn't started.
- **Inject `rng` for reproducibility.** A seeded generator makes dungeon
  topology, encounter spawns, and dice rolls identical across runs — invaluable
  in tests.
- **Some actions are free.** Only methods registered against a character's action
  budget count toward the per-round limit. `move` and `attack` are budgeted;
  `equip`, `unequip`, `craft`, `repair`, and `takeDamage` are deliberately free.
- **Protected state is symbol-gated.** Ownership, durability, equipment, and
  immunities are mutated through exported `Symbol`s rather than public setters,
  so external code can't forge them. You won't touch these for a basic flow.

## Next steps

You just wired a campaign together by hand to see the moving parts. For real
authoring, prefer the declarative builder:

- **[Get Wicked](./get-wicked)** — the **canonical pattern for authoring
  campaigns**. Describe the whole world declaratively with `defineRegistry` +
  `authorTemplate` (rooms, exits, loot, mobs, NPCs, scenes, encounters, crafting,
  custom mechanics, win/lose conditions), then `startSession` to play. It's one
  runnable file that exercises *every* engine mechanic at least once.
- **[Architecture](./architecture)** — the authoritative deep dive: combat and
  mitigation math, status effects, mobs and encounters, loot, crafting,
  durability, equipment slots, keys, and dialogue.
- **[Data model](./data-model)** — how campaigns, characters, rooms, and items
  relate.
- **[API Reference](/api/)** — generated from the TSDoc in `src/lib`, always in
  sync with the source.
