# The behavior DSL

The closed, deterministic expression/statement language inside `[behaviors.*]`
bodies (source of truth: `crates/wickedways-author/src/expr/parser.rs`, `stmt.rs`,
`damage_body.rs`). **Everything not listed here is a compile error** — there are no
user-defined functions, loops, or variables beyond `state`.

## Body kinds — which grammar goes where

| Body | Grammar |
|---|---|
| exit `canPass`, scene `canPlay`, victory `test` | one **expression** |
| scene `onEnter`/`onExit`, item `onUse`/`onRead`, mechanic hooks + `actions`, card `onPlay` | **statement block** (newline-separated) |
| npc dialogue `effects` | **emit-only** statement block (`emit …` lines only) |
| exit `runScript` | statement block where `pass <expr>` is also legal |
| mechanic `modifyDamage` | **transform** body (its own grammar, below) |

## Expressions

Operators, loosest to tightest: ternary `?:` · `||` · `&&` · `==` `!=` · `<` `<=`
`>` `>=` · `+` `-` · `*` `/` · unary `!` · postfix `[index]`, `.field`, calls.
Literals: numbers, `true`/`false`, strings in `'…'` or `"…"`.

**Subjects** (bare identifiers — anything else is an error):

| Subject | Meaning |
|---|---|
| `actor` | the acting character |
| `party` | the list of player characters (`party[0]` = first) |
| `round` / `maxRounds` | current round / the campaign cap |
| `damage` | the damage event — `modifyDamage` bodies only |
| `action` | the action event — action contexts (mechanic `onAction`) |
| `element` | the bound item inside a `some`/`every` predicate |

**Fields** (via `.field`):

- character: `.health` `.sanity` `.energy` `.name` `.id` `.roomId` `.status`
  (list of status keys) `.room` (the room object)
- room: `.name` `.id` `.lit` `.occupants` (list of characters)
- `damage`: `.amount` `.target` (an id string) `.stat` `.source` (the attacker's
  id string on the attack path, else null) `.room` (the TARGET's room id — lets a
  `modifyDamage` reason about co-location via `some(party, element.roomId == damage.room && …)`)
- `action`: `.kind` `.room`

**Functions** (complete list; ★ = second/first arg must be a string literal):

| Call | Meaning |
|---|---|
| `hasKey(who, '<keyCode>')` ★ | holds an item whose `keyCode` matches |
| `hasItem(who, '<itemKey>')` ★ | holds the item |
| `hasEquipped(who, '<itemKey>')` ★ | has the item equipped |
| `stateGet('<field>', <literal default>)` ★ | read this behavior's state field |
| `stateGetIn('<mapField>', <keyExpr>, <literal default>)` ★ | read a string-keyed state map |
| `worldGet('<field>', <literal default>)` ★ | read the campaign's WORLD-scoped state — readable in every context (victory tests included); written via `emit setWorld(...)` |
| `some(list, pred)` / `every(list, pred)` | quantifiers; `pred` reads `element` |
| `includes(list, value)` | list membership |
| `length(list)` / `first(list)` | list ops |
| `str(number)` | number → string (JS formatting) |
| `concat(a, b, …)` | string concatenation (≥ 1 arg) |
| `defined(expr)` | non-null check |
| `mapLit('k1', v1, 'k2', v2, …)` | static literal map — only as the map of `has`/`lookup` |
| `has(map, key)` / `lookup(map, key)` | membership / value in a `mapLit` |

Common predicates:
`party[0].room.name == 'Attic'` · `hasKey(actor, 'cellar')` ·
`actor.sanity <= 0` · `some(party, element.room.name == 'Vault')` ·
`!stateGet('seen', false)`

## Statement blocks

One statement per line; blank lines ignored. Keywords (complete list):

```text
guard <expr>                      # stop the whole body unless <expr> is truthy
when <expr> { <statements> }      # conditional block (nestable)
set state.<field> = <expr>        # write this behavior's persistent state
set state.<map>[<keyExpr>] = <expr>
emit <effect>(…)                  # queue an effect (below)
pass <expr>                       # exit runScript only: narration on success
```

**Effects** (complete list — anything else is an error):

| Effect | Args |
|---|---|
| `cue(<textExpr>)` | narration line to the player |
| `adjustStat(<target>, <stat>, <deltaExpr>)` | `<stat>` is a bare keyword: `sanity` / `health` / `energy` |
| `damage(<target>, <amountExpr>)` | health damage (mitigation applies) |
| `heal(<target>, <amountExpr>)` | health heal |
| `grantImmunity(<target>, <turnsExpr>)` | all-status immunity |
| `giveItem(<fromExpr>, <toExpr>, <itemExpr>)` | hand an item over (ids or subjects) |
| `setVisible(<targetExpr>, <boolExpr>)` | show/hide a character (e.g. `'npc:The Caretaker'`) |
| `setWorld('<field>', <valueExpr>)` | write one field of the campaign's world-scoped state (the cross-behavior channel `worldGet` reads — a night clock a victory test can check, a ward a card can break) |
| `status(field('<label>', <valueExpr>[, <emphasisExpr>]), …)` | HUD status bar readout |

Example (a mechanic that drains sanity in the dark):

```toml
[behaviors.mechanic.dwindling-light]
onTurnStart = '''
  guard !hasEquipped(actor, 'lantern')
  emit adjustStat(actor, sanity, -1)
  when actor.sanity <= 3 {
    emit cue('The dark is inside your eyes now.')
  }
'''
```

Character-reference strings for `giveItem`/`setVisible` use the engine id forms
`'npc:<Name>'` / `'npc:<Name>:item#<n>'` — copy the pattern from
`campaigns/g2-npc.toml` rather than inventing one.

## `modifyDamage` transform bodies

Not statements — a value grammar over the `damage` subject:

```text
body := final <expr>            # halt the transform chain with this amount
      | <cond> ? <body> : <body>
      | <expr>                  # the (possibly adjusted) amount
```

Example (cap damage at 3): `damage.amount > 3 ? final 3 : damage.amount`

## Determinism rules

No randomness, no clocks, no loops. Strings from numbers format like JavaScript.
If a design needs randomness, express it through the engine's own systems
(encounter chance, formation weights) instead.

## State is scoped PER BEHAVIOR KEY — world state is the one shared channel

`state` / `stateGet` read and write **this behavior's own** state — a scene's
`set state.lit = true` is invisible to a victory `test`'s `stateGet('lit', …)`.
When behaviors genuinely must share a fact (a night clock a victory condition
reads, a flag a card flips), use the WORLD-scoped state instead: any effect
body writes it with `emit setWorld('field', <expr>)` and every context —
victory tests included — reads it with `worldGet('field', <default>)`.
Otherwise, write victory conditions as world predicates, the way the shipped
campaigns do:

- reach a place holding a thing: `first(party).room.name == 'Attic' && hasItem(first(party), 'journal')`
- any character broken: `some(party, element.sanity <= 0)`
- whole party down: `length(party) > 0 && every(party, includes(element.status, 'ko'))`
