# NPC Dialogue System — Sub-plan 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Engine foundation for interactable NPCs: a `visible` flag (view/scope hide invisible NPCs), `talk` made non-time-advancing + `Talk` resolving a visible NPC occupant (no dialogue content yet), NPC inventory seeding (so an NPC can hold an item), and two new closed effects `GiveItem` + `SetVisible`.

**Spec:** `docs/superpowers/specs/2026-07-08-npc-foundation-design.md`. **Sequencing note:** `examine`→NPC-description moved to Sub-plan 2 (it needs `NpcScript.description`); this sub-plan is the content-free plumbing.

## Global Constraints
- Differential gate is the authority; fix Rust/oracle in lockstep, never edit a golden or `conformance/canonical-json.ts`.
- `no_std` (`cargo build -p wickedways-core --no-default-features`); `bindings:check` green (new `visible` field + effect variants regenerate); `checks:phase2` green.
- `GameSession.start` stays sync.

---

## Task 1: `visible` flag + view/scope filter
**Files:** `crates/wickedways-core/src/world/snapshot.rs` (`CharacterSnapshot` ~112-146); `crates/wickedways-core/src/world/view.rs` (occupants builder ~293-318); `src/lib/character/character.ts` (`[SERIALIZE]` base ~1116-1134) + `src/lib/serialization/types.ts` (`CharacterSnapshot`); Rust + TS tests.

- [ ] Failing Rust test: a character with `visible: false` in a room is absent from `view.occupants` and `view.scope`; a snapshot WITHOUT a `visible` key parses to `visible: true` (backward-compat).
- [ ] Add `visible: bool` to `CharacterSnapshot` with `#[serde(default = "default_true")]` + a `fn default_true() -> bool { true }` (no existing value-default in this struct — this is the pattern). Place it in the optional tail (~line 145).
- [ ] Filter in `view.rs` at the occupants `.filter(|id| *id != &active_id)` (line ~296): also `&& self.characters.get(id).map_or(true, |c| c.visible)`. Because `scope` reuses the `occupants` vec (view.rs:404), this one filter covers both.
- [ ] TS: add `visible` to the character `[SERIALIZE]` base + `CharacterSnapshot` type + `Character`'s `#visible` (default true); the TS view projection (`oracle-view.ts`/gen-helpers) filters invisible occupants to match.
- [ ] Regen bindings (`CharacterSnapshot.ts`), stage, `bindings:check`. Run Rust+TS tests, no_std. Commit.

## Task 2: `talk` non-advancing + `Talk` resolves an NPC occupant + parser verb
**Files:** `crates/wickedways-core/src/world/intent.rs` (`is_time_advancing` ~47-57); `crates/wickedways-core/src/world/submit.rs` (`Talk` arm ~316-320); `conformance/fixtures/oracle-session.ts` (`TIME_ADVANCING` :42, talk arm :217-220); `packages/play-surface/src/crt/parser.ts` (add `talk` verb) + `controller.ts` (route to `session.execute`); tests.

- [ ] Failing tests: `is_time_advancing(Talk)` is `false`; a `Talk` to a co-located **visible** `Npc` id resolves (no throw — a quiet no-op / placeholder cue in this sub-plan); a `Talk` to a missing/invisible NPC returns `ProceduralViolation` (pin the message, e.g. `"There's no one here to talk to."`).
- [ ] Remove `| Intent::Talk { .. }` from `is_time_advancing` (intent.rs) and `"talk"` from the oracle `TIME_ADVANCING` set — **in lockstep**.
- [ ] Rewrite the `Talk` dispatch arm (submit.rs + oracle-session.ts): resolve `npc_id` against the actor's current room, requiring `kind == Npc` && `visible`; not found → `ProceduralViolation`. Found → placeholder (Sub-plan 2 runs the dialogue behavior). Non-advancing means `submit` skips start_turn/mob-reactions/next_player for talk (already gated by `advances`).
- [ ] CRT parser: add a `talk`/`talk to` verb producing `{ kind: "talk", npcId, prompt? }`, incl. a **quoted-prompt** arg (`talk to keeper "how do I get out"`); the controller routes it through `session.execute` (talk is now non-advancing, so `execute`'s undo-stash is correctly skipped). Parser unit test for bare + quoted forms.
- [ ] Run tests (Rust + `pnpm -r typecheck` + parser test), no_std. Commit.

## Task 3: `GiveItem` + `SetVisible` effects
**Files:** `crates/wickedways-core/src/world/mechanics/mod.rs` (`Effect` ~30-39); `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`apply_effect` ~67-94); `crates/wickedways-core/src/script/ast.rs` (`EffectTemplate` ~119-126); `crates/wickedways-core/src/script/eval.rs` (`build_effect` ~317-346); the TS oracle apply path; bindings; tests.

- [ ] Failing Rust tests: `apply_effect(GiveItem{from,to,item})` moves the item id from `from`'s `inventory.item_ids`/`key_ids` to `to`'s (keys→key_ids), leaving `World.items` unchanged (reachability intact); `apply_effect(SetVisible{target,visible})` sets the flag.
- [ ] Add `Effect::GiveItem { from, to, item }` + `Effect::SetVisible { target, visible }` to the closed enum; `apply_effect` arms (mirror the take/drop id-move in `items_actions.rs` lines ~137-151/523 for GiveItem; a direct field set for SetVisible). GiveItem: reject if `from` doesn't hold `item` (ProceduralViolation) — mirror the carrying guard.
- [ ] Add `EffectTemplate::GiveItem { from: Expr, to: Expr, item: Expr }` + `SetVisible { target: Expr, visible: Expr /* bool */ }`; map them in `build_effect` (`as_character_id`/`as_item_id`/a bool eval). Add `Expr`-level item-id resolution if not present.
- [ ] TS oracle apply: mirror both effects in whatever applies `Effect`s on the oracle side (the engine's effect application driving `serializeCampaign`). Keep byte-parity.
- [ ] Regen bindings (`Effect`/`EffectTemplate`), stage, `bindings:check`. Run tests, no_std. Commit.

## Task 4: NPC inventory seeding (so an NPC can hold an item)
**Files:** `src/lib/authoring/template-builder.ts` (`.npc(...)` ~126-134 — add a `holds?: string[]`); `src/lib/authoring/assembler.ts` (NPC assembly ~272-288 — seed held items like the mob-drop path ~231-234); Rust: confirm an `Npc` with `inventory.item_ids` round-trips + serializes the held `ItemSnapshot` (reachability); tests.

- [ ] Failing test: an authored NPC with `holds: ["items/cellar-key"]` serializes with the key in its `inventory` (item or key list) AND a matching `ItemSnapshot` in the campaign `items` (reachability) — so a later `GiveItem(from=npc)` has a real item to move.
- [ ] Extend `.npc({ ..., holds })`; in the assembler, for each held key build the item (`registry.item(k)()` / key factory), assign a deterministic id (`npc:{name}:item#{i}` mirroring `mob:{name}:drop#{i}`), and add to the NPC's inventory + campaign items (keys via the key list, per `createKey`). NPCs already force `inventorySlots: 5`.
- [ ] Confirm the Rust core treats an `Npc`'s inventory items correctly (no mob/player-only assumptions break); a held key is in `inventory.key_ids`.
- [ ] Run tests, typecheck, no_std. Commit.

## Task 5: Differential fixture + docs + gate
- [ ] A facade/differential fixture (mirror `facade-*`): seed a visible `Npc` holding a key in a room; assert it appears in `view.occupants`; `talk` to it is non-advancing (round unchanged) and resolves (placeholder); apply `GiveItem` (npc→player) + `SetVisible(npc,false)` (via a test mechanic or the effect path) → the item moves and the NPC vanishes from the view. Register the generator; replay byte-identical.
- [ ] README: note the `visible` flag + `talk` (non-advancing) + `GiveItem`/`SetVisible` (brief; NPC content lands in Sub-plans 2-3).
- [ ] `pnpm run checks:phase2` green. Commit.

## Self-Review
- Interfaces produced for Sub-plan 2: `Effect::GiveItem`/`SetVisible` + templates; `visible` flag + view filter; `Talk` resolves a visible NPC occupant (non-advancing); NPC-`holds` seeding. Sub-plan 2 consumes all of these.
