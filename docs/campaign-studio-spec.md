# Campaign Studio Spec (the `wickedways-studio` crate)

> A graphical, browser-based authoring app for the TOML campaign format. Companion to the
> author-format prose in [`README.md`](../README.md) ("The Rust campaign author (G2 MVP)"),
> the schema itself (`crates/wickedways-author/src/author_doc.rs`), the assemble-time
> validator (`crates/wickedways-assemble/src/validate.rs`), and the fixtures corpus
> ([`conformance/fixtures/README.md`](../conformance/fixtures/README.md)).
> `crates/wickedways-web` is the **pattern template** — the studio mirrors its idioms but
> shares no code with it.

## Implementation status (built)

**P0 + P1 (the MVP) and P2 are implemented** as `crates/wickedways-studio`, including both
upstream `wickedways-author` changes: the `Serialize` derives on `author_doc.rs` (change #1
below) and the public span-bearing single-body validators (`wickedways_author::validate`,
change #2) — the studio's per-field layer 3 dispatches to them directly; the MVP's
probe-document hack is gone. All asset-family CRUD screens, the room hub, the return-exit
convenience, the four validation layers, localStorage persistence, and TOML import/export
ship, plus the P2 set: a bounded coalescing **undo** stack, **compiled-artifact export**
(description/catalog/genesis JSON from a green Check-campaign gate), **file-picker import**
(alongside paste), the **full template gallery** (all single-feature fixtures), and the
**unreachable-rooms** reachability lint. The flagship round-trip corpus test
(`crates/wickedways-studio/tests/roundtrip.rs`) holds compiled equality over every fixture.
One remaining simplification vs. the letter of this spec: autosave is a synchronous
write-through rather than a 500 ms debounce (blobs are tens of KB). P3 (graph view, embedded
playtest, structured builders, multi-error compile, desktop arm) remains open; the sections
below are the design.

## Context

Campaigns are authored today by hand-writing TOML against the `AuthorDoc` surface and
compiling with `wwauthor` (or `wickedways_author::compile`). That works — the entire shipped
Hollow House campaign is authored this way (`conformance/fixtures/hollow-house.toml`, 369
lines) — but the barrier is real: an author must memorize a large camelCase schema
(`deny_unknown_fields` — one stray key is a hard error), a web of name/key cross-references,
and the behavior DSL, and `compile()` reports **one error at a time** with spans that are
only meaningful inside a single expression string.

**Campaign Studio** is a graphical authoring app: CRUD screens for every asset family,
guided reference linking (room pickers, item pickers, behavior-key links), live layered
validation with an all-errors problems panel, browser-storage persistence, and TOML
**import and export**. The TOML file stays the canonical interchange format — the studio is
a friendlier way to produce and edit one, not a replacement for it.

**Non-goals (v1):**

- **No server.** The studio is a fully static wasm bundle. `wickedways-author` and
  `wickedways-assemble` are wasm-clean (no rand/uuid/getrandom, no system deps), so
  `compile()` and `validate()` run in-browser — authoritative validation needs no round-trip.
- **No structured behavior builders.** Behavior bodies (`canPass`, `onUse`, `onEnter`,
  mechanic hooks, …) are edited as raw DSL text with live compiler-backed validation.
  Form/block-based builders that generate the DSL are deferred (P3).
- **No editing of description fields unreachable from TOML.** `endedNarration`, `chat`,
  `av`, and standalone `materials` are not authorable in TOML today; the TOML surface is
  the studio's surface. If the author crate grows them, the studio follows.
- **No TOML decompile.** Lowering is lossy and normalizing (expression strings become ASTs,
  key items get synthesized shapes), so compiled `description`/`catalog` JSON can never be
  turned back into TOML. The studio's model is `AuthorDoc`-shaped, never
  `CompiledCampaign`-shaped.
- **No collaboration / multi-user editing.** One browser, one author, localStorage.

The fixtures corpus does double duty: the 22 TOML sources are the **import-test corpus**
(round-trip gate, below) and the seed **templates** offered on the campaign-list screen
("start from Hollow House", "start from Covenant", or any single-feature `g2-*` example).

## Architecture: a new crate, `wickedways-studio`

The studio is a **separate application from `wickedways-web`** — a new workspace member,
`crates/wickedways-studio`. The audiences differ (authors vs. players), the state shapes
differ (a document editor vs. a live game driver), and there is no session code to share;
folding it into the play client would bloat the player bundle and entangle `driver.rs`'s
action model with editor state. What *is* shared is upstream crates and idioms, not code.

- **Crate shape:** dioxus 0.6.3 (web feature), edition 2021, `lints.workspace = true`,
  primary target `wasm32-unknown-unknown`. Dependencies: `wickedways-author`,
  `wickedways-assemble` (the studio is the author crate's **first in-repo consumer**),
  `serde`/`serde_json`, `toml`, `dioxus`, `wasm-bindgen`/`js-sys`/`web-sys` (Storage, plus
  the Blob/anchor APIs for file download and `FileReader` for upload).
- **House patterns mirrored from `wickedways-web`** (copy these, don't reinvent):
  - a `platform.rs` seam wrapping `web_sys` localStorage (`storage_read`/`storage_write`),
    written so a `native-app` arm can slot in later (deferred);
  - a `savestore.rs`-shaped storage module with a namespaced key scheme (below);
  - `include_str!` CSS injected as `style {}` nodes, flat BEM-ish class names
    (`.studio-…`), theme via CSS custom properties, `--color-error`/`--color-warn` tokens;
  - hand-rolled routing — a route enum + URL query params + `history.replaceState`
    (no `dioxus-router`), so every editor location is deep-linkable;
  - signals + a `use_coroutine` action-enum driver (the `PncAction` pattern → a
    `StudioAction` enum owning storage writes and compile runs);
  - the form idioms of `lobby.rs` (signal-bound `input`/`select`, `use_callback`,
    error-signal + conditional `<p>`) and the `Overlay`-enum modal idiom
    (backdrop click-to-dismiss + `stop_propagation` frame).
- **Two deliberate departures from house style, called out here so they don't read as
  drift:** (1) the editor document plus its derived validation state is a deep tree touched
  by every screen, so the studio introduces the codebase's **first `provide_context`** — a
  `StudioStore` context holding `Signal<EditorDoc>` and derived problem signals — instead
  of prop-drilling; (2) a CRUD app genuinely decomposes into many small `#[component]`s,
  unlike the play client's monolithic surface functions.
- **Build/serve/deploy:** `dx serve` for dev; a `build-studio.sh` cloned from
  `crates/wickedways-web/build-web.sh` (cargo wasm32 build → pinned `wasm-bindgen` CLI →
  inject loader into its own `index.html`) producing a **static bundle** — no server
  component. Optionally the root `Dockerfile` later serves it at a `/studio` path beside
  the game client; that is packaging polish, not P0.

## The document model

**`EditorDoc` is `AuthorDoc`-shaped, field-for-field.** The studio defines its own
`EditorDoc` mirror (author stays UI-agnostic) whose only addition is a **stable editor id**
per asset — a monotonic counter, never persisted into TOML — so selection, problems, and
undo survive renames. Conversion is total in both directions: import wraps a deserialized
`AuthorDoc` with fresh ids; export strips ids and serializes. Nothing else is invented — no
alternate abstraction over the TOML surface, so the studio can never author something the
compiler rejects structurally.

### The reference graph

This table drives pickers, rename propagation, and the live integrity lint. It is the
studio's contract with the format:

| Reference | Kind | From |
|---|---|---|
| Room **name** | name | `startRoom`; `exits.from`/`exits.to`; `mobs.room`; `npcs.room`; `loot.room`; `caches.room`; `scenes.room` |
| Item **key** | key | `loot.items[]`; `mobs.drops[]`; `npcs.holds[]`; `rooms.lights[]`; `recipes.outputItem`; formation `MobSpec.drops[]` |
| Placement ↔ behavior (shared key) | key | `exits.behavior → behaviors.exit.<k>`; `scenes.key → behaviors.scene.<k>`; `items.key → behaviors.item.<k>`; `npcs.behavior → behaviors.npc.<k>`; `mechanics.key → behaviors.mechanic.<k>`; `cards.key → behaviors.card.<k>` |
| Villain | name/key | `villain.character` → a mob name, an npc name, or the sentinel `"@gm"` (mob-first resolution); `villain.deck[]` → a `[[cards]]` key **or** a native `wicked:*` key with no local entry |
| Victory | inline | `[[victory.win]]`/`[[victory.lose]]` entries own their behavior inline (the `test` string); the arrays are **ordered** and order is meaningful |
| Free-form by design | — | `archetypes.id` (referenced only at seating time); recipe/cache material component names (no layer of the pipeline validates them — deliberate; cf. the "DELIBERATE DIVERGENCE" note on recipe keys in `crates/wickedways-assemble/src/validate.rs`). The UI keeps these as free text; do not "fix" them with pickers. |

Two shared-key subtleties the UI must honor: an item's `behaviors.item.<key>` entry is
**optional** (most items have no behavior — the format's one deliberately weak validation),
and `wicked:*` deck keys must be free-typable in the deck editor.

### Mutation rules

- **Rename propagates, with confirmation.** Renaming a room or an item key rewrites every
  in-document reference (the studio owns the whole doc, so this is a pure function over
  `EditorDoc`); the confirm dialog lists what will be touched. A rename that collides with
  an existing name/key in the same family is blocked. Shared behavior keys follow the
  asset: renaming an item key renames its `behaviors.item.<key>` entry too.
- **Behavior-body text is never rewritten.** References inside raw DSL text (e.g.
  `hasItem(actor, 'brass-key')`) are opaque strings; auto-rewriting quoted literals is
  risky. The integrity pass *flags* stale-looking literals instead (best-effort, info
  severity). This is an explicit, accepted limitation.
- **Deletes never cascade.** Deleting a referenced asset is allowed; the confirm dialog
  shows the count of references that will dangle, and the problems panel lights up
  immediately after. Silent cascade deletion of dependents is forbidden.
- **Undo is phased.** P0/P1 rely on debounced autosave; P2 adds a bounded snapshot stack of
  `EditorDoc` clones — cheap, since a full real campaign is tens of KB (Hollow House's TOML
  is 369 lines).

## Screens & navigation

Routing is a route enum serialized to query params (`?c=<campaignId>&s=<section>&a=<editorId>`),
navigated exactly like `wickedways-web`'s launcher (write params first, then set the signal).
Modals ride one `Overlay` enum signal (delete confirm, rename confirm, import errors).

1. **Campaign list** (home) — enumerates the storage index. Actions: new blank, new from
   template (bundled fixture TOMLs via `include_str!`), import `.toml` (file upload),
   duplicate, delete, export. Shows per-campaign title, last-saved time, and approximate
   storage usage.
2. **Editor shell** — persistent left nav of asset-family sections with live per-section
   problem badges; header carries the campaign title, save-state indicator, a **Check
   campaign** button, and **Export**.
3. **Campaign settings** — `title`, `startRoom` (room picker), `opts.maxRounds`,
   `opts.baseEncounterChance`, `timeoutNarration`.
4. **Rooms** — list + form (`name`, `description`, `dark`, `spawnModifier`, `lights` as an
   item multi-picker). The room detail page is the **room hub**: panels for this room's
   exits (out *and* in), loot, caches, mobs, NPCs, and scenes — each entry editable in
   place or jump-to-owner, plus "add X here" shortcuts that pre-fill `room`. The hub is how
   "attach things to rooms" works without changing the format's flat-array truth.
5. **Exits** — see the next section.
6. **Items** — the widest form. `type`, `slot`, and `stat` are **dropdowns, never free
   text**: `ItemType` (consumable | armor | weapon | throwable | accessory | key),
   `SlotKind` (hand | finger | wrist | head | torso | legs | feet), `StatType` (health |
   sanity | energy). This is mandatory because `lower_item` **silently defaults** an
   unrecognized string instead of erroring — a typo compiles clean and misbehaves at
   runtime. Conditional field groups by type (weapon/armor → `slot`/`twoHanded`/`modifier`;
   consumable → `usable`/`stat`; key → `keyCode`; plus `emitsLight`, `maxDurability`,
   `lore`, `aliases`, `droppable`, `destroyable`, `recipe`).
7. **Loot / Caches / Recipes** — simple forms. `loot.items` and `recipes.outputItem` use
   item pickers; material component names stay free text (see the reference table).
8. **Mobs / NPCs / Archetypes** — stat tables (`health`/`sanity`/`energy`); mob
   `drops`/`materialDrops`/`naturalAttack {stat, power}`; NPC `behavior` link with a
   "create behavior" shortcut when the key has no `[behaviors.npc.*]` entry yet;
   archetype `baseStats`/`inventorySlots`/`immunities`.
9. **Formations & encounters** — presented **honestly**: formations are a *global weighted
   encounter table*, not room attachments. The screen lists `[[formations]]` entries
   (`key`, `weight`, and the `MobSpec[]` roster — noting `MobSpec` is stricter than
   `[[mobs]]`: `naturalAttack`, `baseEscapeChance`, and `actionsPerRound` are **required**),
   plus a read-only per-room encounter-bias panel (`spawnModifier` against
   `opts.baseEncounterChance`). The room hub links here; nothing in the UI may imply a
   formation belongs to a room.
10. **Scenes / Mechanics / Cards / Villain** — placement forms with linked behavior
    editors. Scenes: `room`, `key`, `phase` (enter | exit), `initialState`. Mechanics: the
    `[[mechanics]]` opt-in (`key`, optional `config`) linked to its behavior table. Villain:
    `character` picker (mobs ∪ npcs ∪ `@gm`) and `deck` as an ordered list of card keys
    with free-typed `wicked:*` allowed.
11. **Victory** — two ordered, reorderable lists (win / lose): `key`, `test` (a raw
    expression editor), `narration`. Order is preserved into the exported arrays.
12. **Behavior editors** — one shared component parameterized by family, rendering that
    family's field shape:
    - **exit**: `canPass` (required expression) + `runScript` (script body — the only body
      where `pass <expr>` is legal) + `passMessage`/`failMessage`;
    - **scene**: `canPlay` (expression) + `onEnter`/`onExit` (statement bodies);
    - **item**: `onUse`/`onRead` (statement bodies);
    - **npc**: `description`, a required `default` entry, and an ordered `dialogue[]` — each
      entry's polymorphic `match` gets a small structured sub-form (exact string | fuzzy
      token list), `response`, `once`, and an **emit-only** `effects` body;
    - **mechanic**: `init` (state seed), the five lifecycle hooks (`onRoundStart`,
      `onRoundEnd`, `onTurnStart`, `onTurnEnd`, `onAction`), `modifyDamage` (its own
      transform grammar: `<cond> ? final <expr> : <expr>` over the `damage` subject), and
      the `actions` map (action key → statement body);
    - **card**: `onPlay`.

    Every body field is a monospace textarea with validate-on-idle and inline errors, plus
    a collapsible **DSL reference sidebar** generated from this vocabulary:
    subjects `actor` `party` `round` `maxRounds` `damage` `action` `element`; calls
    `hasKey(x,'k')` `hasItem(x,'k')` `hasEquipped(x,'k')` `stateGet('f', default)`
    `stateGetIn('map', key, default)` `mapLit(k,v,…)` `lookup(map,key)` `has(map,key)`
    `some(list,pred)` `every(list,pred)` `includes(list,v)` `str(x)` `length(x)` `first(x)`
    `defined(x)` `concat(…)`; operators (loosest→tightest) `?:` `||` `&&` `==`/`!=`
    `<`/`<=`/`>`/`>=` `+`/`-` `*`/`/` unary `!`/`-` postfix `.field`/`[i]`; statements
    `guard <expr>`, `when <expr> { … }`, `set state.<f> = <expr>`,
    `set state.<map>[<key>] = <expr>`, `emit <effect>`, `pass <expr>` (exit `runScript`
    only); effects `cue` `adjustStat(target, stat, delta)` `giveItem` `setVisible`
    `status(field(label, value[, emphasis]), …)` `damage` `heal` `grantImmunity`.

## Exit-linking UX

The format's truth, stated first: exits are **standalone directional edges** —
`[[exits]] { from, to, direction }` keyed by room *names*, with optional `behavior`, `name`,
`initialState`, and `oneWay`. A two-way passage is two entries.

- **List/form-based editing first.** The exit form uses room pickers for both ends and a
  direction dropdown. A **"create return exit"** convenience generates the reverse edge on
  save — opposite direction, swapped ends, copying `behavior` and `name` (a locked door
  usually shares one behavior key), individually detachable afterwards.
- **Asymmetry is made visible, not forbidden.** The room hub shows "exits out" and "exits
  in" side by side; an info-severity lint flags a non-`oneWay` exit with no plausible
  return edge. One-way passages are a legitimate design tool.
- **Graph/map view is deferred (P3), read-only first.** The compass-delta layout in
  `crates/wickedways-web/src/map.rs` (and `wickedways-tabletop`'s `map`) is prior art to
  borrow. The list + room hub covers the authoring workflow without it.

## Validation architecture — four layers

Cheapest and liveliest first; each layer exists because the layer below it can't do its job:

| # | Layer | When | Mechanism |
|---|---|---|---|
| 1 | Field constraints | per keystroke | Enum dropdowns (mandatory — see the silent-default hazard), required fields, numeric inputs for stats/weights/chances, non-empty + unique-within-family names/keys. |
| 2 | Referential integrity | debounced after every mutation | A pure `fn check_refs(&EditorDoc) -> Vec<StudioProblem>` implementing the reference-graph table in the studio itself: **all errors at once**, each `StudioProblem { severity, message, target: (family, editor_id, field) }` — machine-addressable, so the problems panel, per-section badges, and inline field markers are all clickable. |
| 3 | Behavior-body DSL | on idle, per field | The body text compiled in isolation and `ExprParse`/`UnknownReference` spans mapped into the textarea — spans are relative to the expression string (`EXPR_BASE = 1,1`), which is exactly what an in-editor marker needs. |
| 4 | Authoritative gate | **Check campaign** + pre-export | `EditorDoc` → TOML text → `wickedways_author::compile()` → on success `wickedways_assemble::validate` (collect-all `Vec<Problem>`) and the `validate_mechanics`/`validate_behavior` shape rules the pipeline runs. The compiler is the trust boundary; layers 1–3 exist to make reaching a green gate pleasant, not to replace it. |

Why layer 2 duplicates upstream logic: `compile()` returns **one** `CompileError` at a time
with no asset/field context, and `wickedways_assemble::validate` — though collect-all and
structured (`DuplicateName`, `UndefinedRoom { ctx, room }`, `UnregisteredItem { ctx, key }`,
`Unregistered{Condition,Scene,Exit,Formation,Npc,Mechanic,Card}`, `DuplicateMechanic`,
`UndefinedVillainCharacter`, …) — operates on the *compiled* description, with human `ctx`
strings that don't map mechanically back to editor assets. The studio-native check gives
live, all-errors, click-to-navigate feedback; the assemble problems are additionally mapped
onto assets by name/key (best-effort) as a cross-check whenever the gate runs.

Layer 3's MVP mechanism is deliberately a hack: build a minimal **probe `AuthorDoc`**
containing just enough scaffolding plus the single body under edit, and run `compile()` on
it. It works today with zero upstream changes; P2 replaces it with public parse entry
points (below) for lower latency and exact per-family context rules (e.g. `pass` legality)
without scaffolding.

**Export with outstanding errors is allowed, with a warning.** Authors need to round-trip
broken drafts; the export dialog shows the current problem count. The gate blocks nothing
except the author's confidence.

## Persistence & import/export

- **Storage schema.** One JSON blob per campaign — the serialized `EditorDoc` — under
  `wickedways:studio:campaign:<id>`, plus an index at `wickedways:studio:index` (a JSON
  array of `{ id, title, updatedAt, schemaVersion }`). Ids are generated wasm-clean
  (time + counter via `js_sys`, no `getrandom`). Every blob carries `schemaVersion: 1`;
  on load, older versions run an upgrade function; an unknown *newer* version is refused
  with a warning naming the version — the blob is left untouched (opening it through an
  older `EditorDoc` shape could silently drop fields the newer studio wrote).
- **Why JSON of the editor model, not TOML text:** it preserves editor ids and in-progress
  state that isn't yet valid TOML, and avoids reparsing on every load. TOML is the
  *interchange* format only — produced on export, consumed on import.
- **Autosave** is a debounced (≈500 ms) write-through on every mutation, via the platform
  seam — the `savestore.rs` pattern. localStorage's ~5 MB ceiling is generous here
  (campaigns are tens of KB), but the campaign list shows approximate usage and a failed
  write surfaces a persistent error banner (the `LogLine::error` idiom), never a silent drop.
- **Import** — file upload → `toml::from_str::<AuthorDoc>`. The serde layer
  (`deny_unknown_fields`) produces stringified errors with line/col text; they are shown
  verbatim in the import dialog. Import always **creates a new campaign** — it never mutates
  an existing one in place.
- **Export** — `EditorDoc` → `AuthorDoc` → TOML serialization → Blob download named
  `<title-slug>.toml`. Arrays serialize in editor order (victory order is meaningful).
  Comments and original formatting of an imported file are **lost** — accepted, and why
  round-trip equivalence is defined at the *compiled* level (Verification).

## Required upstream changes to `wickedways-author`

The studio mandates a short list, each cheap and behavior-preserving for existing users:

1. **`Serialize` derives across the `author_doc.rs` tree**, with
   `#[serde(skip_serializing_if = "Option::is_none")]` on optionals and skip-empty on
   `Vec`/map fields where absence is the authored idiom — **P0, blocks export.** Mechanical:
   the existing `rename_all = "camelCase"` / `rename = "type"` / `rename = "match"`
   attributes apply symmetrically (the untagged `MatchToml` serializes correctly). The
   alternative — a parallel serialize-only model in the studio — is pure duplication-drift
   risk and is rejected. No golden changes expected (goldens pin *compile output*, not the
   author structs' serialization), but the change runs the author gate like any other.
2. **Public span-bearing parse entry points** for a single expression, statement body, and
   `modifyDamage` transform (thin wrappers over the existing internal parsers) — **P2.**
   Replaces the probe-doc hack: per-field latency drops and per-family rules (`allow_pass`,
   emit-only effects) become directly checkable.
3. **A multi-error `compile_all` variant** collecting `Vec<CompileError>` instead of
   failing fast — **P3, optional.** Nice for the gate loop; not blocking, because layer 2
   already provides all-errors liveness.

Explicitly **not** requested: per-value TOML position tracking (heavy, and the studio
addresses assets structurally, not by file span), and any change to `compile()`'s signature.

## Playtest hook (phased)

Because author + assemble are wasm-clean, the full pipeline — TOML → `compile()` →
`assemble()` → genesis snapshot + catalog — runs in the studio's browser tab.
`wickedways-web`'s `driver::rebuild_single` proves the last hop is possible.

- **P2:** an "Export compiled" action downloads `description`/`catalog` (and optionally an
  assembled genesis) JSON — the same artifacts `wwauthor` writes — for use with the
  existing tooling.
- **P3:** a true **Playtest** button handing off to the game client. This depends on
  `wickedways-web` growing a load-external-campaign entry point (today campaigns are
  `include_str!`-bundled; `driver.rs` itself notes manifest-driven assembly as future
  work). That is a cross-crate ask, flagged here — not assumed.

## Phasing

- **P0 — skeleton + persistence + interchange.** Upstream change #1 first. Then: crate
  scaffold, `build-studio.sh`, routing, campaign list, storage schema + autosave, import,
  export, campaign-settings screen. Gate: `hollow-house.toml` round-trips at compiled
  equality.
- **P1 — full CRUD + integrity (the MVP).** Rooms with the room hub; exits with the
  return-exit convenience; items with enum-constrained forms; loot/caches/recipes;
  mobs/NPCs/archetypes; the formations screen; scenes/mechanics/cards/villain; victory
  lists; the shared behavior editor with probe-doc validation; `check_refs` + problems
  panel + badges; the **Check campaign** gate.
- **P2 — polish.** Upstream parse entry points → precise per-field validation; the undo
  stack; compiled-artifact export; the template gallery; extra lints (missing return
  exits, rooms unreachable from `startRoom` via BFS — info severity).
- **P3 — deferred.** Graph/map view; embedded playtest; structured behavior builders;
  `compile_all`; a native desktop arm behind the platform seam; IndexedDB if the
  localStorage ceiling ever bites.

## Verification

- **Workspace gates:** `cargo build -p wickedways-studio --target wasm32-unknown-unknown`,
  `cargo clippy -p wickedways-studio --all-targets --target wasm32-unknown-unknown -- -D warnings`,
  `cargo fmt --all --check`, `cargo test --workspace`.
- **The flagship test — round-trip over the corpus** (native, not wasm): for each of the 22
  fixture TOMLs, import → `EditorDoc` → export TOML → `compile()` both the original and the
  exported text → assert the compiled `description` + `catalog` JSON are **equal**.
  Compiled equality is the round-trip equivalence relation (comments/formatting are lossy
  by design). This one test pins the entire import/export path against the same corpus the
  author gate pins `compile()` with.
- **Unit tests:** `check_refs` against fabricated dangling references in every family;
  rename propagation (every reference rewritten, behavior-body text untouched but flagged,
  collisions blocked); storage schema migration; reverse-exit generation.
- **Behavior validation tests:** known-bad bodies per family produce errors whose spans map
  to the right textarea offsets.
- **Live drive:** `dx serve` + headless Chromium — from blank: create two rooms, link exits
  both ways, add an item and a mob, attach loot, run Check campaign to green, export,
  re-import, verify equality. (Scripted e2e later; manual first, matching the
  `crates/wickedways-web/e2e` precedent.)
- When the crate lands, `README.md` gains its row in the workspace table and a studio
  section (the CLAUDE.md living-documentation rule).

## Resolved decisions

1. **Separate app vs. a `wickedways-web` surface** → separate crate `wickedways-studio`;
   shares upstream crates and idioms, not code.
2. **Scope** → CRUD for all asset families; exit linking; room-attachment UX via the room
   hub (with formations presented as the global encounter table they are); browser-storage
   persistence; full validation; TOML import **and** export.
3. **Behavior editing** → raw DSL text with live compiler-backed validation; structured
   builders deferred to P3.
4. **Deliverable** → this spec precedes any implementation.
5. **Storage format** → JSON-serialized `EditorDoc` per campaign + an index key; TOML is
   interchange only.
6. **Renames** → propagate through the document with a confirmation dialog; behavior-body
   text is flagged, never rewritten.
7. **Exit UX** → list/form-based with a create-return-exit convenience; graph view P3.
8. **Round-trip oracle** → compiled-JSON equality, not textual TOML equality.
9. **Export of a broken draft** → allowed, with the problem count shown at export time.
