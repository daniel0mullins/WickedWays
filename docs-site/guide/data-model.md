# Data model

A campaign exists in two shapes, and the difference is the heart of the authoring
design:

- A **campaign template** is what an author *writes* — a reusable, player-less
  world. Content is referenced by **name** (rooms, mobs, loot), and behaviors
  (item factories, recipes) are referenced by **typed registry key**. Items are
  not entities here; they are keys that containers point at.
- A **live campaign instance** is what *runs* — the template instantiated and
  played. Players have joined (so a party, a GM, and an active character appear),
  and every entity is a real object wired to others by **id**. This is exactly the
  shape the serialization layer persists in a `CampaignSnapshot`.

The same world, twice: authored as named content + registry keys, then realized as
an id-wired object graph.

## Campaign template (authoring)

What `authorTemplate(title, registry, opts)` accumulates and `.build()` assembles.
`ItemKey` / `RecipeKey` are entries in the `TypedRegistry` from `defineRegistry`,
and they are what `mob.drops`, `loot.items`, `room.lights`, and `.recipe()`
reference — compile-time-checked against the registered keys.

```mermaid
erDiagram
    CampaignTemplate ||--o{ ArchetypeDef : archetypes
    CampaignTemplate ||--o{ RoomDef : rooms
    CampaignTemplate ||--o{ ExitDef : exits
    CampaignTemplate ||--o{ MobDef : mobs
    CampaignTemplate ||--o{ LootDef : loot
    CampaignTemplate ||--o{ CacheDef : caches
    CampaignTemplate ||--|| RoomDef : startRoom
    CampaignTemplate }o--o{ RecipeKey : recipes
    CampaignTemplate ||--|| TypedRegistry : "built with"
    CampaignTemplate ||--o{ ConditionRef : winConditions
    CampaignTemplate ||--o{ ConditionRef : loseConditions
    CampaignTemplate ||--o| ChatPolicy : chat
    CampaignTemplate ||--o| AvPolicy : av

    RoomDef ||--o{ ExitDef : "from / to"
    MobDef }o--|| RoomDef : "placed in"
    LootDef }o--|| RoomDef : "placed in"
    CacheDef }o--|| RoomDef : "placed in"

    MobDef }o--o{ ItemKey : drops
    LootDef }o--o{ ItemKey : items
    RoomDef }o--o{ ItemKey : lights

    TypedRegistry ||--o{ ItemKey : "defines factory"
    TypedRegistry ||--o{ RecipeKey : "defines recipe"
    TypedRegistry ||--o{ ConditionKey : "defines predicate"

    CampaignTemplate {
        string title
        int maxRounds
        string startRoom
        OutcomeNarration timeoutNarration
        OutcomeNarration endedNarration
        ChatPolicy chat
        AvPolicy av
    }
    ChatPolicy {
        boolean enabled
        boolean whisper
        boolean edit
        boolean reactions
        boolean readReceipts
        boolean typing
        int backfillWindow
    }
    AvPolicy {
        boolean enabled
        boolean video
        int maxParticipants
    }
    ArchetypeDef {
        string id
        string name
        StatMods statModifiers
        int inventorySlots
    }
    RoomDef {
        string name
        string description
        boolean dark
        int spawnModifier
    }
    ExitDef {
        string from
        Direction direction
        string to
    }
    MobDef {
        string name
        Stats stats
        int actionsPerRound
        number baseEscapeChance
    }
    LootDef {
        string name
        string description
    }
    CacheDef {
        string name
        MaterialMap materials
    }
    TypedRegistry {
        ItemKey items
        RecipeKey recipes
        ConditionKey conditions
    }
    ItemKey {
        string key
    }
    RecipeKey {
        string key
    }
    ConditionKey {
        string key
    }
    ConditionRef {
        string key
        OutcomeNarration narration
    }
```

## Live campaign instance (runtime)

The object graph the engine plays and the serializer captures. Items are real
entities held by characters, stored in loot boxes, or placed as room light
sources; rooms link to rooms via directional exits; characters occupy rooms;
players carry an archetype. The campaign tracks its party, its GM, and the active
character.

```mermaid
erDiagram
    Campaign ||--o{ Room : rooms
    Campaign ||--o{ Character : characters
    Campaign ||--o{ Item : items
    Campaign ||--o{ Loot : loot
    Campaign ||--o{ MaterialCache : caches
    Campaign ||--o{ CodexEntry : codex
    Campaign ||--o{ Archetype : archetypes
    Campaign }o--|| Character : gm
    Campaign }o--|| Character : active
    Campaign ||--o{ VictoryCondition : "winConditions"
    Campaign ||--o{ VictoryCondition : "loseConditions"

    Room }o--o{ Room : exits
    Room ||--o{ Character : occupants
    Room ||--o{ Loot : contains
    Room ||--o{ MaterialCache : contains
    Room ||--o{ Item : lights

    Character }o--o| Room : currentRoom
    Character ||--o{ Item : inventory
    Character ||--o{ Item : equipped
    Character }o--o| Archetype : archetype

    Loot ||--o{ Item : contents

    Campaign {
        string id
        string title
        int round
        boolean started
        CampaignOutcome outcome
        string outcomeReason
    }
    Room {
        string id
        string name
        boolean dark
    }
    Character {
        string kind
        string id
        string name
        Stats stats
    }
    Item {
        string id
        string behaviorKey
        int modifier
    }
    Loot {
        string id
        int capacity
    }
    MaterialCache {
        string id
        boolean depleted
    }
    Archetype {
        string id
        string name
    }
    VictoryCondition {
        string key
        OutcomeNarration narration
    }
```

## From template to instance

`instantiate(template)` clones a template snapshot with a fresh campaign id (the
world unchanged) to produce an instance genesis. Players then join via the
authoritative `joinCampaign` command — each bringing a `Character` and choosing one
of the template's archetypes — and the GM begins via `beginCampaign`. The
named-content + typed-keys template becomes the id-wired, player-populated instance
above.
