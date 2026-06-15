# Character Archetypes — Design

**Date:** 2026-06-15
**Status:** Approved (pending implementation plan)

## Summary

Add **character archetypes** to character creation. An archetype is an authored,
declarative descriptor — registered into a per-campaign catalog — that a player
character selects during setup. Selecting one **modifies a character's baseline**:
it layers stat deltas on top of the character's provided base stats, adjusts
inventory slot capacity, and grants standing status immunities. Every player
character must have an archetype before the campaign begins.

Archetypes follow the codebase's established "authored data + engine applies it"
pattern (`Item`, `CraftingRecipe`, `Formation`) and the campaign-catalog pattern
(`discoverRecipe`, `addFormation`).

## Motivation

Character creation today constructs a `PlayerCharacter` with explicit `stats` and
`inventorySlots` and no notion of a class/role. Archetypes give players a
campaign-defined role to choose, expressed purely through the three levers named
in the request: base stats, inventory slots, and immunities.

## Scope

### In scope

An archetype can affect exactly three things:

1. **Base stats** — deltas added once to the character's base `Stats`.
2. **Inventory slots** — a delta added once to inventory capacity.
3. **Immunities** — standing status immunities (a new passive immunity source).

### Out of scope (YAGNI)

- `actionsPerRound` or any other character attribute.
- Re-selecting / changing an archetype after it is chosen.
- Reassignment mid-campaign.
- A symbol seam for the selection operation (see Security model).

## Design decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Stat relationship | **Modifies a baseline** — base stats/slots are still passed to the constructor; the archetype applies deltas on top. |
| Attachment | **Campaign catalog + select by id** — registered on the campaign (like recipes/formations); the character selects one by id, validated against the catalog. |
| Requirement & lifecycle | **Required at `beginCampaign`, locked after** — a character may be constructed without one, but `beginCampaign()` throws if any party member lacks an archetype. Once selected it cannot change. |
| Selection cardinality | **Once-only.** Re-selecting throws, so deltas are applied exactly once (no double-apply). |
| Immunities | A **new passive source**, unioned with equipped-gear immunities on every reconcile. |

## Components

### 1. `Archetype` descriptor — new file `src/lib/archetype.ts`

A plain declarative interface (no class, no factory), in the style of the `Item`
descriptor.

```ts
import type { Brand } from "./brand";
import type { Stats } from "./character/stats";
import type { Status } from "./status";

/** Unique identifier for an {@link Archetype}. */
export type ArchetypeId = Brand<string, "ArchetypeId">;

/**
 * An authored character role registered on a campaign. Selecting it modifies a
 * player character's baseline once: stat deltas layer on the provided base stats,
 * the slot delta adjusts inventory capacity, and the immunities become a standing
 * passive trait.
 */
export interface Archetype {
  id: ArchetypeId;
  name: string;
  /** Deltas added once to base stats at selection. A missing stat contributes +0. */
  statModifiers?: Partial<Stats>;
  /** Delta added once to inventory slot capacity (resulting capacity floored at 0). */
  inventorySlots?: number;
  /**
   * Standing status immunities while this archetype is held. Covers Panic/Fear/
   * Confused; KO is never immunizable and a listed KO is ignored (consistent with
   * item immunities today).
   */
  immunities?: Status[];
}
```

### 2. Campaign catalog — additions to `Campaign` / `ICampaign`

Mirrors `discoverRecipe` / `knownRecipes`:

- `registerArchetype(a: Archetype): void` — adds to the catalog, **idempotent by
  id** (first definition wins; later calls with the same id are no-ops).
- `get archetypes(): ReadonlyMap<ArchetypeId, Archetype>` — read-only view (the
  live map exposed as `ReadonlyMap`, matching `knownRecipes`).

Backed by a private `#archetypes: Map<ArchetypeId, Archetype>`. May be seeded via
an optional constructor argument later if desired, but the initial design adds
only the runtime registration method (keeps the constructor signature stable).

### 3. `beginCampaign` enforcement

`beginCampaign()` gains one guard, after the existing party/GM checks:

> If any member of `party` has no selected archetype, throw
> `ProceduralViolation("Cannot begin a campaign whose party members have not all chosen an archetype")`.

This mirrors the existing GM-membership validation.

### 4. Selection — `PlayerCharacter.selectArchetype(id)`

`PlayerCharacter` is where campaign membership and other player-only setup live, so
selection is a `PlayerCharacter` method.

```ts
selectArchetype(id: ArchetypeId): void
```

Behaviour:

1. **Locked-after-begin:** throw `ProceduralViolation` if the campaign has already
   begun. (The campaign exposes no public `started` flag today; this design adds a
   minimal read-only accessor — `get started(): boolean` on `ICampaign` — used only
   for this guard. Alternative considered: route selection through a campaign method
   that already knows `#started`; rejected to keep selection on the character.)
2. **Once-only:** throw `ProceduralViolation` if this character already has an
   archetype.
3. **Catalog validation:** throw `ProceduralViolation` if `id` is not in
   `campaign.archetypes`.
4. **Apply (exactly once):**
   - For each stat in `statModifiers`, `this.stats[stat] += delta`.
   - `inventory.slots = max(0, inventory.slots + (inventorySlots ?? 0))`.
   - Store the archetype reference in a private field and cache its immunities for
     the passive-immunity union.

Exposes `get archetype(): Archetype | undefined`.

### 5. Immunity flow — `Character.#passiveImmunities()`

Today `#passiveImmunities()` builds a `Set<Status>` from equipped, intact items'
`immunities`. It gains a union with the selected archetype's immunities, held in a
private field on the character (set during `selectArchetype`). No public setter —
same hidden-state discipline as the rest of the character.

Because the archetype trait is consulted inside `#passiveImmunities()`, it flows
automatically through both `applyFromStats` (every reconcile) and the timed-immunity
reconciliation in `onTurnStart`, exactly like gear-based passive immunity. No
changes to `Afflictions` are required.

`selectArchetype` lives on `PlayerCharacter`, but the immunities field and the
union live on `Character` so the affliction machinery (which is all on `Character`)
sees it. The base class holds the field and the union; the subclass method writes
it (via a `protected` setter or by assigning the protected field directly).

## Data flow

```
setup:
  campaign.registerArchetype(brawler)         // catalog, idempotent by id
  pc = new PlayerCharacter(campaign, name, baseStats, baseSlots)
  pc.selectArchetype(brawler.id)              // applies deltas once; caches immunities
      └─ stats += statModifiers
         inventory.slots = max(0, slots + inventorySlots)
         archetype + immunities stored (private)
  campaign.gm = pc
  campaign.beginCampaign()                    // throws if any party member lacks an archetype

play (unchanged code paths):
  takeDamage / startTurn → #reconcile → applyFromStats(snapshot, #passiveImmunities())
      └─ #passiveImmunities() now unions gear immunities ∪ archetype immunities
```

## Error handling

All illegal operations throw `ProceduralViolation`, consistent with the engine:

- `selectArchetype` after the campaign has begun.
- `selectArchetype` when an archetype is already selected.
- `selectArchetype` with an id absent from the catalog.
- `beginCampaign` with any party member lacking an archetype.

`registerArchetype` does **not** throw on a duplicate id — it is idempotent (first
wins), matching `discoverRecipe`.

## Security / integrity model

- The archetype reference and its cached immunities are **private** with no public
  setter, preserving the hidden-state pattern.
- Catalog validation + once-only selection + locked-after-begin make
  `selectArchetype` itself the sole sanctioned application path, so **no symbol
  seam is needed** (unlike ownership/durability/equip, which can be reached from
  multiple call sites). This is an explicit non-goal.
- Stat deltas are plain arithmetic on the already-mutable `stats`; slot capacity is
  floored at 0 to keep it non-negative.

## Testing strategy

- **`src/lib/archetype.test.ts`** — descriptor shape; catalog registration is
  idempotent by id (first definition wins); `archetypes` view is read-only.
- **`src/lib/campaign.test.ts`** — `registerArchetype` adds to the catalog;
  `beginCampaign` throws when a party member has no archetype and succeeds when all
  do.
- **`src/lib/character/player-character.test.ts`** — `selectArchetype` applies stat
  deltas and the slot delta; floors slots at 0; throws on unknown id, on a second
  selection, and after the campaign has begun; `archetype` getter reflects the
  choice.
- **`src/lib/character/character.test.ts`** (or `afflictions`-adjacent) — archetype
  immunities suppress the matching status and are correctly **unioned** with
  gear-based passive immunity; KO is never immunized even if listed.
- **`src/integration.test.ts`** — wire archetypes into the full-campaign setup so
  the end-to-end turn loop exercises selection + enforcement.

All randomness already routes through injected `rng`; archetypes add no new
randomness, so existing deterministic-test patterns are unaffected.

## Documentation

Per the project convention (update README + TSDoc after a feature), add a
"Character archetypes" section to `README.md` under character creation, and TSDoc
on the new `Archetype` interface, the campaign catalog methods, and
`selectArchetype`.
