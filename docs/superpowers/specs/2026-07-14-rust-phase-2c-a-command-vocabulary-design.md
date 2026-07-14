# Rust Phase 2c — Sub-project A: the actor-tagged Command vocabulary (design)

**Date:** 2026-07-14
**Status:** design
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md) (sub-project **A**)
**Consumer:** [`2026-07-14-rust-phase-2c-b-sync-core-design.md`](./2026-07-14-rust-phase-2c-b-sync-core-design.md) (B depends on A)
**Frozen oracle:** `src/lib/sync/types.ts` (the `Command` union + classifiers), `src/lib/sync/resolver.ts`
(the authorize gate + apply dispatch), and the TS engine actions they invoke.

## Goal

Give the Rust core the **multiplayer command model**: the actor-tagged `Command` union (mirroring
`src/lib/sync/types.ts:20`), its classifiers, the resolver **authorize gate** (`resolver.ts:30`), and
the engine-action bindings each command kind dispatches to. This is what sub-project B (the sync core)
resolves and diffs; without it B has nothing to submit.

The single-player cutover already gave the core a party/turn loop and a *subset* of the action
vocabulary. A closes the gap: the full multiplayer command surface, actor-tagged, gated, and bound to
engine actions that in most cases already have their data model in place.

## Scope boundary: what A owns vs. what C owns

An important correction the exploration surfaced. The program design's A row bundled "seat↔identity
ownership; gating by remote identity" with the command model. In the frozen oracle those are **two
different layers**:

- **In-campaign role gating** — is it this character's turn? is the campaign started? is there a GM?
  This lives in the core resolver (`resolver.ts` checks `actorId === campaign.activeCharacter.id`,
  `started`/`finished`, `gm` set). **This is A.**
- **Human↔seat ownership** — which authenticated identity is allowed to act *as* a given character.
  This is `Membership.mayAct` in `packages/server/src/membership.ts`, explicitly "server protocol
  state, NOT in the snapshot." **This is sub-project C (the axum server), not A.**

So A does **not** add any network-identity, seat, or ownership field to `World`/`CharacterSnapshot`
(the core has none today — `gm_id` is the only identity-ish field, and it's an inert passthrough). A
owns the *command model and the in-campaign role gate*; C owns the human-seat map on top.

## The command union (mirror `types.ts`)

Introduce a serde, internally-tagged (`#[serde(tag = "kind", rename_all = "camelCase")]`) multiplayer
`Command` in `wickedways-core`, distinct from the existing internal single-seat `Command`
(`world/command.rs`) — name it to avoid the collision (e.g. `SyncCommand`, or move the existing one to
an internal name). Every turn-action carries `actor_id`; the union also has the setup/join/GM/lifecycle
arms. Port the classifiers verbatim: `is_turn_action`, `is_setup_command`, `is_gm_command`,
`is_join_command`, `command_actor_id` (the constant kind-sets from `types.ts:84`).

## The authorize gate (mirror `resolver.ts`)

A pure function `authorize(&World, &Command) -> AuthResult` (`Ok` | `Err(reason)`), porting the four
branches from `resolver.ts:30` exactly:

- **turn-action** → campaign started, not finished, and `actor_id == active_character_id`.
- **setup** (`selectArchetype`) → only before start.
- **join** → not finished, and `character.kind == Player`.
- **GM** → `gm` set; `beginCampaign` requires not-started, all other GM commands require started.

Deeper validation stays in the engine actions (a `ProceduralViolation` on illegal state, which B's
authority turns into a `denied` result via its restore-on-violation path). B calls this gate; A
provides it.

## Engine-action coverage (the real work)

The action *data models* mostly already exist in the core; the missing piece is invokable actions.
Verified per-command status:

| Command | Status | What A must add |
| --- | --- | --- |
| `takeFromLootBox` | thin-binding | `World::take` already ports take-from-container + add-to-inventory; add `lootId`-scoping + `itemIds[]` batching |
| `pickUp` | thin-binding | reuse `take` (its doc already says it mirrors `addToInventory`/`pickUp`); add batch |
| `mobAttack` | thin-binding | expose the actor-agnostic `World::attack` with a mob `actorId` (already the mechanic `run_mob_reactions` drives internally, `submit.rs:49`) |
| `craft` | partial | `Catalog.recipes` + char `known_recipes` exist; author the transactional consume-materials → mint-item action |
| `repair` | partial | `durability`/`max_durability` + the `set_durability` write-seam exist; author restore-toward-max (mirror TS repair, incl. any material cost) |
| `harvest` | partial | material caches + campaign `materials` pool + `deposit_materials` primitive exist; author drain-cache → deposit |
| `transferKey` / `consumeKey` | partial | key rings + `key_code` + `has_key` + campaign `claims` exist (`drop_item` already refers callers to `transferKey`); author transfer + consume |
| `placeLight` / `takeLight` | partial | `light_source_ids` + `emits_light` + `is_lit` exist (read-only today); author move-item between inventory and `room.light_source_ids` |
| `selectArchetype` | partial | `archetype_id` + `archetype_immunities` exist (id always `None` today); author the setter that applies immunities |
| `transferGM` | partial | `gm_id` field exists (inert); author the setter + the GM-command gate reads it |
| `putInLootBox` | absent-mechanic | inverse of `take`: remove from inventory → add to a named container. New action. |
| `leaveCampaign` | absent-mechanic | remove a player from `party_ids` (+ turn-order bookkeeping). New action. |
| `mobEscape` | absent-mechanic | only `base_escape_chance` + an unused `Escape` history variant exist; author the escape-roll/flee behavior on the injected rng |
| `move`/`attack`/`equip`/`unequip`/`use`/`drop`/`begin`/`end`/`nextPlayer` | done | already invokable in the core; A only actor-tags them |

**Reuse the write-seams, not raw field mutation.** New mutating actions route through the existing
protected seams (`set_durability`, `deposit_materials`, the keyring/claims accessors) — the Rust
analogue of CLAUDE.md's symbol-seam rule — rather than poking snapshot fields directly.

**`mobEscape` is the one genuinely-new behavior.** Everything else is either a thin binding or an
action over an existing model; the escape roll (read `base_escape_chance`, roll the injected rng, flee
or fail, record the `Escape` history entry) has no counterpart in `run_mob_reactions` today and must be
built to match the TS mob's `escape()`.

## Decomposition (slices), aligned to B's MVP

A is sequenced so B can start the moment A0 lands and grow its differential gate as A1/A2 arrive:

- **A0 — command model + gate + supported subset.** The `Command` union, classifiers, `authorize`,
  and actor-tagging the already-invokable actions (move/attack/equip/unequip/use/take/drop/begin/end/
  nextPlayer). **This is B's hard prerequisite** and unblocks B's MVP gate.
- **A1 — the "partial" actions.** craft, repair, harvest, transferKey/consumeKey, placeLight/takeLight,
  selectArchetype. Each authors an action over an existing model and adds its command binding.
- **A2 — the new mechanics + lifecycle.** putInLootBox, leaveCampaign, transferGM, mobEscape, and the
  explicit `mobAttack`. Each extends the command union coverage and B's gate.

Every slice widens the same differential corpus B is gated against — a command isn't "done" until its
delta matches the TS oracle.

## The oracle / gate

A shares B's differential mechanism (record the TS engine's per-command effect as committed goldens;
replay in Rust):

1. **Authorize parity** — the `authorize` verdict (ok / denied + reason) matches `resolver.ts` for
   each command across all four branches, including the edge cases in `resolver.test.ts`.
2. **Action-effect parity** — submitting each command through B's `SyncAuthority` yields a `to_snapshot`
   (and thus a `Delta`) identical to the TS engine applying the same command — this is where the
   craft/repair/harvest/key/light/archetype action ports are proven correct.
3. **Behavioral goldens** — the existing `resolver.test.ts` / `types.test.ts` are the behavioral spec
   the goldens derive from.

## Constraints held

- **Panic-free** — an illegal command is an `authorize` rejection or a `ProceduralViolation` (→ B's
  `denied`), never a panic. Carried from the G2 author-boundary discipline.
- **Determinism** — the one randomized action (`mobEscape`) draws only the injected rng, so replays are
  bit-reproducible.
- **Snapshot parity preserved** — A adds *actions*, not new snapshot shapes; the `*Snapshot` types stay
  byte-compatible with the TS serializer (the whole differential gate rests on this).
- **No new identity/seat state in the core** — human-seat ownership is C's `Membership`; A keeps the
  core free of network concepts (only the in-campaign `gm_id` role, now made settable).

## Next step

Plan A0 first (command union + classifiers + `authorize` + actor-tagging the supported subset), since
it is B's prerequisite; then A1/A2 as the engine-action ports, each landing with its command binding
and its slice of the differential corpus. B's MVP can proceed in parallel the moment A0 is in.
