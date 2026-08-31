# The campaign TOML format

The exact surface `wickedways_author::compile` accepts (source of truth:
`crates/wickedways-author/src/author_doc.rs`). Every table is
`deny_unknown_fields`: a key not listed here is a **hard compile error**. All keys
are camelCase. "Optional" means the key may be omitted entirely — absent-means-default
is the house idiom; never write a key just to give it its default.

## Top level

| Key | Type | Required | Meaning |
|---|---|---|---|
| `title` | string | **yes** | Campaign name. |
| `startRoom` | string | for playable campaigns | A `[[rooms]]` `name` — where the party starts. |
| `[opts]` | table | no | `maxRounds` (int, default 100), `baseEncounterChance` (int %, default 20). |
| `timeoutNarration` | string | no | Narration shown when the round limit is hit. |

Asset arrays (all optional): `[[archetypes]]`, `[[rooms]]`, `[[exits]]`, `[[items]]`,
`[[loot]]`, `[[caches]]`, `[[recipes]]`, `[[scenes]]`, `[[npcs]]`, `[[mobs]]`,
`[[formations]]`, `[[mechanics]]`, `[[cards]]`, `[[victory.win]]`, `[[victory.lose]]`.
Single tables: `[villain]`, the `[behaviors.*]` trees.

## `[[archetypes]]` — player-character templates

| Key | Type | Required |
|---|---|---|
| `id` | string | yes |
| `name` | string | yes |
| `baseStats` | table `{ statName = number }` | no |
| `inventorySlots` | int | no |
| `immunities` | array of status keys | no |

## `[[rooms]]`

| Key | Type | Required |
|---|---|---|
| `name` | string | yes — the id every other table references |
| `description` | string | yes |
| `dark` | bool | no — unlit room (darkness mechanic) |
| `spawnModifier` | int | no — biases this room's encounter roll |
| `lights` | array of item keys | no — items that light this room when carried lit |

## `[mapGen]` — procedural map generation (optional)

When present, the campaign authors **no `[[exits]]`** (mixing them is a compile
error): the engine wires the declared rooms at `begin_campaign` via a randomized
spanning tree drawn from the seeded rng — every room reachable, bidirectional
exits, no self-connections, a different layout each playthrough seed.

| Key | Type | Required |
|---|---|---|
| `extraConnections` | number | no — loop edges beyond the spanning tree: an absolute count, or a fraction of `n - 1` when strictly between 0 and 1 |
| `required` | array of tables (`[[mapGen.required]]`) | no — room pairs pinned as neighbors in every layout |
| `maxExitsPerRoom` | int | no — per-room exit cap, clamped to 2..8 (default 8) |
| `sealed` | array of room names | no — rooms reachable ONLY through `required` passages (a locked crypt's keyed door stays its sole entrance); every sealed room must appear in a `required` entry |

A `[[mapGen.required]]` entry (the place for keyed doors in a generated map):

| Key | Type | Required |
|---|---|---|
| `from` | string | yes — a room `name` |
| `to` | string | yes — a room `name` |
| `behavior` | string | no — a `[behaviors.exit.<key>]` key |
| `name` | string | no — display name ("mausoleum gate") |
| `initialState` | inline table | no — seed state, e.g. `{ unlocked = false }` |

The generator assigns compass directions; a required entry carries none.

## `[[exits]]` — one-directional; write the return leg yourself

| Key | Type | Required |
|---|---|---|
| `from` | string | yes — a room `name` |
| `to` | string | yes — a room `name` |
| `direction` | string | yes — one of `north` `south` `east` `west` `northeast` `northwest` `southeast` `southwest` |
| `behavior` | string | no — a `[behaviors.exit.<key>]` key (locked/scripted door) |
| `name` | string | no — display name ("cellar door") |
| `initialState` | inline table | no — seed state for a stateful exit, e.g. `{ unlocked = false }` |
| `oneWay` | bool | no |

## `[[items]]`

| Key | Type | Required |
|---|---|---|
| `key` | string | yes — the id loot/drops/holds/recipes reference; also the `[behaviors.item.<key>]` key |
| `name` | string | yes |
| `keyCode` | string | no — makes this a door key; matched by `hasKey(actor, '<keyCode>')` |
| `type` | string | no — `consumable` `armor` `weapon` `throwable` `accessory` `key` |
| `stat` | string | no — `health` `sanity` `energy` (consumables) |
| `modifier` | int | no — consumable stat delta |
| `usable` | bool | no |
| `destroyable` | bool | no — consumed on use |
| `recipe` | inline table `{ component = qty }` | no — crafting cost (inert author-data) |
| `equippable` | bool | no |
| `droppable` | bool | no |
| `slot` | string | no — `hand` `finger` `wrist` `head` `torso` `legs` `feet` |
| `twoHanded` | bool | no |
| `emitsLight` | bool | no — a light source (lantern) |
| `maxDurability` | int | no |
| `lore` | string | no — text shown on `read` |
| `aliases` | array of strings | no — extra names the parser resolves (`lamp` for the lantern) |

## `[[loot]]` — a searchable container placing items in a room

| Key | Type | Required |
|---|---|---|
| `name` | string | yes |
| `room` | string | yes — a room `name` |
| `items` | array of item keys | yes |
| `description` | string | no |

## `[[caches]]` — a one-use pile of crafting materials

`name` (string), `room` (string), `materials` (table `{ component = qty }`) — all required.

## `[[recipes]]` — a crafting recipe the party knows from the start

`id` (string), `outputName` (string), `outputItem` (an `[[items]]` key),
`materials` (table `{ component = qty }`) — all required.

## `[[scenes]]` — a scripted moment attached to a room

| Key | Type | Required |
|---|---|---|
| `room` | string | yes |
| `key` | string | yes — the `[behaviors.scene.<key>]` key |
| `phase` | string | no — `enter` (default) or `exit` |
| `initialState` | inline table | no — seeds the scene's state map |

## `[[npcs]]`

| Key | Type | Required |
|---|---|---|
| `name` | string | yes |
| `stats` | inline table `{ health = f, sanity = f, energy = f }` | yes (all three, numbers) |
| `room` | string | no |
| `behavior` | string | yes — the `[behaviors.npc.<key>]` dialogue key |
| `holds` | array of item keys | no — items it carries (can hand over via dialogue `effects`) |

## `[[mobs]]` — a placed enemy

| Key | Type | Required |
|---|---|---|
| `name` | string | yes |
| `stats` | inline table `{ health, sanity, energy }` | yes |
| `room` | string | no |
| `drops` | array of item keys | no — dropped on defeat |
| `naturalAttack` | inline table `{ stat = "<health|sanity|energy>", power = number }` | no |
| `inventorySlots` | int | no |
| `actionsPerRound` | int | no |
| `baseEscapeChance` | int | no |
| `materialDrops` | inline table | no |
| `lightAverse` | bool | no — flees/avoids lit rooms |

## `[[formations]]` — a random-encounter group

| Key | Type | Required |
|---|---|---|
| `key` | string | yes |
| `weight` | int | no — opt-in weight on the encounter table |
| `mobs` | array of tables | no — each: `name`, `stats`, `naturalAttack` (`{ stat, power }`), `baseEscapeChance` (int), `actionsPerRound` (int) **all required**; `drops`, `lightAverse`, `materialDrops` optional |

Note the formation `mobs` entries are the core `MobSpec`: unlike `[[mobs]]`,
`naturalAttack`/`baseEscapeChance`/`actionsPerRound` are **required** there.

## `[[mechanics]]` — a placed campaign-wide mechanic

`key` (string, required — the `[behaviors.mechanic.<key>]` key) and `config`
(inline table, optional inert author-data the behavior reads).

## `[villain]` and `[[cards]]` — the Wicked Ways card antagonist

`[villain]`: `character` (a mob/npc `name`, or `"@gm"` for the seated GM) and
`deck` (array of card keys, authored order — the engine shuffles).

`[[cards]]`: `key` (doubles as the behavior key — native `wicked:*` or a
`[behaviors.card.<key>]` body), `name`, optional `text`, optional `config`
(inline table, e.g. `{ rounds = 3 }`).

## `[[victory.win]]` / `[[victory.lose]]` — ordered arrays

| Key | Type | Required |
|---|---|---|
| `key` | string | yes |
| `test` | string | yes — a DSL expression (see `dsl.md`) |
| `narration` | string | no |

Always give a playable campaign at least one win condition.

## `[behaviors.*]` — the DSL bodies (grammar in `dsl.md`)

- `[behaviors.exit.<key>]` — `canPass` (expression, **required**), `runScript`
  (script body, may use `pass '<text>'`), `passMessage`, `failMessage` (strings).
- `[behaviors.scene.<key>]` — `canPlay` (expression), `onEnter`, `onExit`
  (statement bodies). All optional.
- `[behaviors.item.<key>]` — `onUse`, `onRead` (statement bodies). Keyed by the
  item's `key`.
- `[behaviors.npc.<key>]` — `description` (string, required), `default` (a dialogue
  entry, required), `dialogue` (array of dialogue entries). A dialogue entry:
  `match` (a bare string for exact, or `{ fuzzy = ["word", …] }`), `response`
  (string, required), `once` (bool), `effects` (emit-only statement body).
- `[behaviors.mechanic.<key>]` — `init` (inline table state seed),
  `onRoundStart` / `onRoundEnd` / `onTurnStart` / `onTurnEnd` / `onAction`
  (statement bodies), `modifyDamage` (transform body), `actions` (table of
  `actionKey = "statement body"`). All optional.
- `[behaviors.card.<key>]` — `onPlay` (statement body).

Multi-line bodies use TOML `'''…'''` literal strings — and because `'''` strings
are literal, DSL string literals inside them use single quotes freely; a
single-line body in `"…"` must use `'…'` for DSL strings too (the DSL accepts both
quote kinds).

## Cross-reference rules (checked at compile/assemble)

- exit `from`/`to`, loot/cache `room`, npc/mob/scene `room` → a `[[rooms]]` `name`
- `startRoom` → a `[[rooms]]` `name`
- loot `items`, mob `drops`, npc `holds`, recipe `outputItem`, room `lights` → an `[[items]]` `key`
- exit `behavior` → `[behaviors.exit.<key>]`; scene `key` → `[behaviors.scene.<key>]`;
  npc `behavior` → `[behaviors.npc.<key>]`; mechanic `key` → `[behaviors.mechanic.<key>]`
- `villain.character` → a `[[mobs]]`/`[[npcs]]` `name` (mob-first) or `"@gm"`
- `villain.deck` entries → native `wicked:*` keys or `[[cards]]` keys
- `hasKey(actor, 'X')` in a `canPass` → some item's `keyCode = "X"`, and that item
  must be obtainable (loot, npc hand-over, or mob drop)
