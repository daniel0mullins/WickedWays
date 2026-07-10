# Rust Engine — Phase 1, Sub-plan 4b: Combat Damage — Design

**Status:** Approved (design), pending spec review
**Date:** 2026-07-01
**Parent:** Phase 1 combat (sub-plan 4), decomposed into 4a (afflictions/gating — shipped),
**4b (combat damage — this doc)**, 4c (mobs/encounters/escape/drops).

## Goal

Port the TypeScript engine's combat-damage mechanics to the Rust core: `attack`,
`takeDamage`, mitigation math, weapon/armor durability decrement, `#reconcile` (including
the persistent base-stat floor), and the reach-KO-via-damage → `onKnockOut` transition —
verified byte-for-byte against the TS oracle by the differential conformance gate.

## Architecture

Combat is a faithful, byte-exact port. The mitigation formula already exists in
`crates/wickedways-core/src/damage.rs` (`compute_mitigated_damage`, `MAX_STAT=10.0`,
`MITIGATION_PER_POINT=0.2`, `LIGHT_VULNERABILITY=1.5`); 4b wires it into a new
`take_damage` and a new `attack`, adds the `set_durability` seam and `#reconcile`, and
introduces one new command (`Command::Attack`). `takeDamage` is **internal-only** (never a
command — TS only invokes it from `attack`).

The pivotal change is representational: TS base stats are `number` and `takeDamage`
subtracts **un-rounded** fractional mitigated damage directly into the base stat
(`this.stats[attackStat] -= dealt`). `#floorAndSnapshot` clamps with `Math.max(0, x)` — not
`Math.floor` — so fractions survive into the serialized snapshot and into affliction
thresholds. The Rust `Stats` struct is currently `i64`; **4b promotes it to `f64`** so
fractional post-damage stats serialize and threshold-compare identically.

## Tech Stack

Rust `no_std` core (`alloc::`), serde 1, serde_json 1, ts-rs 10.1, wasm-pack (nodejs),
vitest 4, pnpm. Gate: `checks:phase3` = `cargo build -p wickedways-core
--no-default-features` (no_std build only — unit tests are NOT no_std, run under default
features) + `cargo test --workspace` + `pnpm run bindings:check` + `pnpm run
test:conformance`.

## Global Constraints

- **Differential gate is the authority.** Divergences are fixed in Rust source, never by
  editing goldens or loosening the comparator (`conformance/canonical-json.ts`).
- **Byte-exact IEEE-754.** All damage arithmetic uses `f64` in the **same operation order**
  as TS. `compute_mitigated_damage` already matches; `stats[stat] -= dealt` must be `f64`
  subtraction.
- **`no_std` core.** Combat code uses `alloc::` only; verified by the no-default-features
  build. Unit tests run under default features.
- **Randomness only through the injected `rng`.** The sole rng draw anywhere in the combat
  path is the Confused fizzle roll inside `gate` (4a), drawn only when Confused is active.
  `take_damage`/`reconcile`/`apply_from_stats` are rng-free.
- **Branded IDs**, **Symbol-seam discipline** (durability writes route through
  `set_durability`), and **`ProceduralViolation` on illegal transitions** per project
  conventions.
- **Unit tests run under default features**, not `--no-default-features` (test modules use
  `vec!`/`String`/std). The no_std guarantee is a **build** check only.

---

## 1. `f64` stat promotion (foundation, behavior-neutral)

TS base stats are `number`; mitigated damage is fractional and un-rounded. Promote:

| Site | Change |
|---|---|
| `crates/wickedways-core/src/stats.rs` — `Stats` | `energy`, `sanity`, `health`: `i64` → `f64` |
| `StatType::mitigator()` | **unchanged** — `Energy→Health, Health→Sanity, Sanity→Energy` (already matches TS `MitigatorStatType`) |
| `resolve.rs` — `effective_stat` | return `f64`; `base (f64) + Σ equipped-accessory modifier (i64, cast to f64)` |
| `afflictions.rs` — `apply_from_stats`, `on_turn_start` | `health/sanity/energy` params `i64` → `f64`; thresholds become float compares (below) |
| `turn.rs` — `start_turn` | base-stat floor `.max(0)` → `.max(0.0)`; passes `f64` effective stats to `on_turn_start` |
| `history.rs` — `ActionHistoryEntry::TakeDamage` | `amount: i64` → `amount: f64` (TS records the fractional `dealt`) |
| snapshot (de)serialize | `Stats` serde over `f64` (serde accepts JSON integers into `f64`) |

**Affliction thresholds after promotion** (literal ports of `apply_from_stats`, values
unchanged, only the type):
- KO: `health <= 0.0` (clears all clearable, returns)
- Panic: `sanity <= 0.0`
- Fear: `sanity > 0.0 && sanity < 5.0`
- Confused: `energy <= 0.0` latch; `energy > 1.0` clear; `(0.0, 1.0]` hold band + immunity
  hysteresis (`energy > 0.0 && energy <= 1.0`).

**`modifier` stays `i64`.** Item `modifier` is an authored integer (`ItemSnapshot::Item.modifier: i64`);
it is cast to `f64` only where combined with stats (`effective_stat`, `attack_matrix`,
`armor_sum`). Widening `modifier` is out of scope.

**Transparency to existing goldens (verified):** every conformance test compares via
`canonicalize()` + `.toEqual()` on **parsed** JS values, and the one string-equality test
(`world-roundtrip.test.ts`) runs `JSON.parse` on both sides before `canonical()`. Rust
emitting `10.0` where TS emits `10` normalizes to the same parsed number `10`, so all
existing goldens pass **unchanged**. Fractional results (`2.4000000000000004`, `7.5`) match
bit-for-bit because Rust performs the same IEEE-754 ops in the same order.

**Task-1 acceptance:** the promotion compiles (`no_std` build + default-features tests),
bindings stay drift-clean (`f64` and `i64` both emit TS `number`), and all existing
conformance goldens stay green with **no behavior change** — this task adds no combat logic.

---

## 2. Mitigation math (already ported — reused verbatim)

`crates/wickedways-core/src/damage.rs::compute_mitigated_damage` — byte-exact to
`src/lib/character/damage.ts`:

```
mitigated_strength = max(0, attack_strength - armor_sum)
damage_multiplier  = max(0, MAX_STAT - mitigator) * MITIGATION_PER_POINT   // 0.2
light_multiplier   = (light_averse && room_lit) ? LIGHT_VULNERABILITY : 1  // 1.5 : 1
dealt              = mitigated_strength * damage_multiplier * light_multiplier   // NO rounding
```

`MAX_STAT=10.0`, `MITIGATION_PER_POINT=0.2`, `LIGHT_VULNERABILITY=1.5`. No 4b change to
`damage.rs`.

---

## 3. `take_damage` — internal `World` method

Byte-exact port of `character.ts:930-971`. **Not a `Command`** — only `attack` calls it.

```
World::take_damage(target: &CharacterId, attack_strength: f64, attack_stat: StatType,
                   cat: &Catalog, cues: &mut Vec<PresentationCue>)
```

Sequence:
1. `armor` = target's inventory items that are **equipped, non-broken, `type==armor`,
   `stat==attack_stat`** (resolved via catalog). `armor_sum = Σ modifier` (i64 → f64).
2. `mitigator = effective_stat(target, attack_stat.mitigator(), cat)` (f64).
3. `light_averse` = target's `light_averse` snapshot field (default `false`); `room_lit` =
   target's current room lit state (existing lit-computation seam).
4. `final = compute_mitigated_damage({ attack_strength, armor_sum, mitigator, light_averse, room_lit })`.
5. `dealt = transform_damage(final, target, attack_stat)` — **no-op passthrough** returning
   `final`. Seam for sub-plan 6 custom mechanics; Phase 1 has none.
6. `stats[attack_stat] -= dealt` (f64; **no clamp here** — negative bases are floored later
   by `reconcile`).
7. Each contributing armor piece with `max_durability` defined →
   `set_durability(id, durability - 1)`.
8. `reconcile(target, cat, cues)`.
9. Record history `TakeDamage { round, amount: dealt, stat: attack_stat }` and emit cue
   `Action { action: TakeDamage, actor: TARGET, sound: None }`. **Not budgeted** —
   `takeDamage` is absent from `isActionMap`, so `actions_this_round` is **not** ticked.

The `Action`/`TakeDamage` variants already exist in `presentation.rs` / `history.rs`.

---

## 4. `attack` — `World` method wired to `Command::Attack`

Byte-exact port of `combatant.ts:49-93`.

```
World::attack(actor: &CharacterId, target: &CharacterId, cat: &Catalog,
              cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>
```

Sequence:
1. **Gate** (`gate(actor, is_move=false)`, from 4a):
   - `Block(reason)` → `Err(ProceduralViolation(reason))` (KO / Panic-on-non-move).
   - `Fizzle` → `record_fumble(actor, "attack", budgeted=true, cues)`; return `Ok(())`.
     (`attack` is in `isActionMap` → a fizzled attack **ticks** budget, like `go`.)
   - `Allow` → continue.
2. **Dark check** (`require_visible_target(actor, "attack")`, after the gate, per TS): if
   the actor's current room exists and is `!lit` and `!sees_in_dark(actor)` →
   `Err(ProceduralViolation("Cannot attack in the dark"))`.
3. `weapons` = actor's inventory items that are **equipped, non-broken, `type==weapon`**.
4. `attack_matrix` over the **fixed key order `[Health, Energy, Sanity]`** (matching TS
   `Record` insertion order iterated by `typedEntries`), init `0.0`:
   - `weapons.is_empty()` → `natural = natural_attack(actor)` (default `{ stat: Health,
     power: 1 }`, parsed from the `natural_attack` snapshot field);
     `attack_matrix[natural.stat] += natural.power`.
   - else each weapon: `attack_matrix[weapon.stat] += weapon.modifier` (i64 → f64).
5. For `stat` in `[Health, Energy, Sanity]` where `strength > 0.0` →
   `take_damage(target, strength, stat, cat, cues)`. **Order matters**: each `take_damage`
   reconciles (floors, re-latches afflictions), so a later stat's mitigation reads the
   updated state.
6. Each swung weapon with `max_durability` defined → `set_durability(id, durability - 1)`
   (**after** damage, matching TS).
7. Record history `Attack { round, target: { id, name } }`, tick budget
   (`actions_this_round += 1`), emit cue `Action { action: Attack, actor: ATTACKER,
   sound: None }`. **Budgeted**.

**Command wiring** (`command.rs`): add `Command::Attack { target_id: String }` with the
same `#[serde(tag = "kind", rename_all = "camelCase")]` shape as siblings — serializes as
`{ "kind": "attack", "targetId": "..." }`. `apply_command` resolves the active actor
(`world.active_character_id()`), wraps `target_id` as `CharacterId`, and calls
`world.attack(&actor, &target, cat, cues)`.

**Target validity** is an oracle invariant: TS `attack(c)` receives a live object, so there
is no bad-`target_id` error path. Rust proceeds; character lookups use the existing
get/get_mut seams (a missing target simply applies no damage). This path is never exercised
by the gate.

---

## 5. `reconcile`, `on_knock_out`, `set_durability`

**`reconcile`** — byte-exact port of `character.ts:330-340`:

```
World::reconcile(actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)
```
1. `was_ko = afflictions.is_active(Ko)`.
2. Persistently floor base stats to `max(0.0, x)` for all three (the `#floorAndSnapshot`
   floor — `character.ts:308-317`; note `Math.max(0, x)`, **not** `Math.floor`).
3. Compute effective `health/sanity/energy` (f64) and `passive = passive_immune(actor, cat)`.
4. `afflictions.apply_from_stats(health, sanity, energy, &passive)`.
5. `is_ko = afflictions.is_active(Ko)`.
6. `if !was_ko && is_ko` → `on_knock_out(actor, cat, cues)`.

`reconcile`'s floor is **independent** of `start_turn`'s floor (4a placed the floor in
`start_turn` only, deliberately, so `reconcile` can floor without double-application).

**`on_knock_out`** — no-op stub with a documented seam:

```
World::on_knock_out(_actor: &CharacterId, _cat: &Catalog, _cues: &mut Vec<PresentationCue>)
// Base behavior: none (matches base Character.onKnockOut).
// Sub-plan 4c: branch on CharacterKind::Mob to drop loot / record encounter.
```
`cues` is plumbed through `reconcile` → `on_knock_out` **now** so 4c wires Mob's override
without re-plumbing signatures. Unused params are underscore-prefixed per project
convention.

**`set_durability`** — the `SET_DURABILITY` seam analog:

```
World::set_durability(item: &ItemId, value: i64)   // sets ItemSnapshot::Item.durability = Some(value)
```
Only `attack` (weapons) and `take_damage` (armor) call it. **No clamp** — matches TS
`SET_DURABILITY`; callers pass `durability - 1`, and only non-broken items (durability ≥ 1)
ever wear, so a wear can reach 0 (→ broken) but never negative.

**Broken-item semantics** (already enforced via `is_broken` at resolve time): broken weapons
do **not** deal damage, broken armor does **not** mitigate, broken items do **not** wear
further (they are filtered out before the durability loop). Broken **accessories still grant
their `effective_stat` bonus** (no `is_broken` filter in `effective_stat`, per TS).

---

## 6. Conformance fixture (`combat.gen.test.ts` + `combat.test.ts`)

**Campaign:** one **lit** room, two player-characters:
- **Ada** — attacker; kept **affliction-free** so her `attack` gate always returns `Allow`
  (no Confused fizzle rng on her turns). Equipped with a weapon (`type=weapon`, a chosen
  `stat`/`modifier`) carrying `maxDurability` so it wears (and can break).
- **Ben** — target; equipped armor defending the attacked stat (with `maxDurability` so it
  wears and can break) plus a mitigator-stat accessory. `light_averse: true` so the `1.5`
  light-vulnerability branch fires (room is lit).

`baseEncounterChance: 0` (no encounters — 4c). A **single `mulberry32(SEED)`** instance is
injected into both PCs and the campaign, so all affliction draws form one ordered sequence
identical to the Rust single `World.rng` (same technique as the 4a fixture). The seed is
chosen (brute-force search over the planned command stream) so the start-turn clear rolls
land the intended affliction outcomes.

**Coverage the stream must exercise:**
- Fractional `dealt` → fractional base stat **serialized** (proves the `f64` path end-to-end).
- Armor `armor_sum` mitigation + mitigator multiplier + the `1.5` light-vulnerability branch.
- Weapon durability wear (Ada) **and** armor durability wear (Ben), including an item
  **reaching 0 → broken** and thereafter not contributing.
- Multi-stat attack (weapon(s) hitting more than one stat) to pin the `[Health, Energy,
  Sanity]` iteration order.
- `reconcile` flooring (a stat driven negative pre-floor → floored `0`).
- **KO transition via damage**: Ben's health reaches `0` → KO latches, `defeated: true`
  flips in Ada's view (4a view field), `on_knock_out` fires once (no-op).
- Damage-driven affliction latching (sanity/energy driven into Fear/Panic/Confused bands
  by damage, re-latched in `reconcile`).
- Budget: `attack` ticks Ada's `actions_this_round`; `take_damage` does **not** tick Ben's.

**Cues carry no sound:** the fixture PCs have no `presentation.sound`, so TS emits no
`sound` and Rust emits `None` (omitted via `skip_serializing_if`), consistent with 4a.

**Golden shape:** `{ seed, commands, steps: [{ command, cues, snapshot, view }] }`.
`combat.test.ts` calls `replay_commands(start, JSON.stringify(commands), catalog, seed)` and
asserts, per step, `canonicalize(step.{cues,snapshot,view})` `.toEqual()` the golden, plus a
step-count assertion — the same differential-gate pattern as `afflictions.test.ts`.

Register `combat.gen.test.ts` in `conformance/fixtures/vitest.config.ts`. Generation must be
isolated: only the four `combat.*` files (`gen.test.ts`, `start.snapshot.json`,
`catalog.json`, `golden.json`) and the `vitest.config.ts` registration change; no other
fixture or `packages/seed` file is touched.

---

## 7. File structure

**New:**
- `crates/wickedways-core/src/world/combat.rs` — `attack`, `take_damage`, `reconcile`,
  `on_knock_out`, `set_durability`, `require_visible_target`, `natural_attack`,
  `transform_damage`, plus unit tests.
- `conformance/combat.test.ts` — differential gate.
- `conformance/fixtures/combat.gen.test.ts` — fixture generator.

**Modified:**
- `crates/wickedways-core/src/stats.rs` — `Stats` → `f64`.
- `crates/wickedways-core/src/world/resolve.rs` — `effective_stat` → `f64`.
- `crates/wickedways-core/src/world/afflictions.rs` — `apply_from_stats` / `on_turn_start`
  params → `f64`.
- `crates/wickedways-core/src/world/turn.rs` — floor `.max(0.0)`; pass `f64`.
- `crates/wickedways-core/src/world/history.rs` — `TakeDamage.amount` → `f64`.
- `crates/wickedways-core/src/world/command.rs` — `Command::Attack` + dispatch.
- `crates/wickedways-core/src/world/mod.rs` — `mod combat;` wiring.
- `conformance/fixtures/vitest.config.ts` — register the new generator.

**Fold-in carries (from the 4a final review):**
- `view.rs:102-104` — stale ViewModel doc ("defeated deferred to sub-plan 4" — now shipped);
  correct it.
- `items_actions.rs` — relabel `TODO(sub-plan 4)` → `TODO(sub-plan 4c)`.

**Docs:** confirm `README.md`'s combat/mitigation section reflects the shipped behavior;
update any TSDoc/Rustdoc as needed (the mitigation math is already documented — verify, do
not duplicate).

---

## 8. Decomposition shape (~6 tasks)

1. **`f64` stat promotion** — `stats.rs`, `effective_stat`, affliction params, `start_turn`
   floor, `TakeDamage.amount`; regression tests; **all existing goldens green, no behavior
   change**. (Also fold the two doc/TODO carries here.)
2. **`set_durability` + `reconcile` + `on_knock_out` stub + `transform_damage`** — the
   post-damage reconcile/floor/KO-transition machinery, unit-tested (KO fires once on
   transition; floor clamps negatives; broken-item wear guard).
3. **`take_damage`** — mitigation + `transform_damage` + subtract + armor durability +
   `reconcile` + non-budgeted `takeDamage` history/cue; unit tests.
4. **`attack` + `Command::Attack` + dispatch** — gate + dark check + weapon matrix (fixed
   order) + natural-attack fallback + weapon durability + budgeted `attack` history/cue;
   unit tests.
5. **`combat.gen.test.ts`** — bespoke campaign + seed search + written goldens; isolation
   verified.
6. **`combat.test.ts`** — differential gate; `checks:phase3` green.

---

## Out of scope (later sub-plans)

- **Mobs, encounters, escape, loot drops** (4c) — including `Mob.onKnockOut`'s loot-drop
  override that hooks the `on_knock_out` seam, and `light_averse` mobs wiring the
  `sees_in_dark` view seam.
- **`TRANSFORM_DAMAGE` custom mechanics** (sub-plan 6) — the `transform_damage` seam stays a
  no-op passthrough in Phase 1.
- **Widening `modifier` / integer types to bigint** — a separate pre-Phase-2 binding pass.
