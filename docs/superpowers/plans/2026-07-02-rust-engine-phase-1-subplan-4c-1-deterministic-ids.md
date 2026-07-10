# Sub-plan 4c-1: Deterministic (Content-Derived) Entity IDs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TS oracle's non-deterministic `uuid()` entity ids with content-derived ids assigned from authoring context (`room:hall`, `mob:wraith`, `loot:chest:item#0`, `player:Ada`, `campaign:<title>`), and regenerate all conformance fixtures deterministically — no mechanic changes, no Rust changes.

**Architecture:** All entity `id` fields are public and mutable (hydration already overwrites them), so we assign content-derived ids **post-construction** at the three construction sites (the assembler for template entities, `startSession` for player-characters, and the two manual gen fixtures). `generateId()`/`uuid()` and the entity constructors are left untouched — the uuid they mint is harmlessly overwritten — so TS unit tests that call `generateId` still work and Rust (which reads ids as opaque strings) needs no change.

**Tech Stack:** TypeScript oracle (`src/`), vitest; Rust core unchanged this sub-plan; pnpm.

**Note on approach vs. spec:** the spec (§1/§2/§6) framed the mechanism as "add injectable `id?` options, modify `util.ts`/`inventory.ts`, retire `uuid()`." This plan intentionally uses the simpler, equivalent mechanism that the codebase enables: **all `id` fields are public and mutable, so ids are assigned post-construction at the caller** (assembler / `startSession` / manual fixtures), and `generateId`/`uuid`/constructors are left untouched (the minted uuid is harmlessly overwritten). Same outcome — content-derived deterministic ids, no shared counter — with a smaller surface and no `src/` unit-test breakage. The campaign id is the title-derived form `campaign:${title}` assigned in the assembler; its mutable `id` field is the override seam a multi-campaign host uses for uniqueness (a formal `CampaignOptions.id` is unnecessary for 4c-1 and deferred).

## Global Constraints

- **No mechanic changes.** The only legitimate golden difference after regeneration is id *strings* (`uuid → content-derived`). **No new field.** Any non-id golden change is a bug.
- **No shared mutable id state.** Ids derive from authoring/mint context only; two campaigns assembled in one process must not interfere. Do NOT add a module-level or per-campaign counter.
- **Content-derived id forms (exact):**
  - `` `campaign:${desc.title}` `` · `` `room:${name}` `` · `` `mob:${name}` `` · `` `cache:${name}` `` · `` `npc:${name}` `` · `` `player:${name}` ``
  - `` `exit:${[fromName, toName].sort().join("|")}` `` (per unordered room-pair)
  - `` `scene:${room}:${behaviorKey}:${phase}` `` (phase defaults to `"enter"`)
  - Items: `` `${parentId}:item#${i}` `` (loot contents) · `` `${parentId}:drop#${i}` `` (mob drops) · `` `${parentId}:light#${i}` `` (room lights), where `parentId` is the parent's content-derived id and `i` is the 0-based array index.
- **`generateId`, `uuid`, and entity constructors are NOT modified.** Ids are assigned by the caller after construction. (The minted uuid is overwritten and never appears in a snapshot.)
- **No Rust core changes.** Rust reads ids as opaque strings; do not touch `crates/`.
- Branded ids require a cast at assignment: `entity.id = \`...\` as XId` (import the brand type).
- Verification commands: `pnpm test` (TS unit suite = `vitest run`), `pnpm run fixtures:gen` (regenerate goldens), `pnpm run checks:phase3` (`cargo build --no-default-features` + `cargo test --workspace` + `bindings:check` + `test:conformance`).

## File Structure

**Modify (TS oracle):**
- `src/lib/authoring/assembler.ts:174-303` — assign content-derived ids to every constructed template entity + its items.
- `src/lib/authoring/orchestration.ts:73` — assign each PlayerCharacter `player:${name}`.
- `conformance/fixtures/afflictions.gen.test.ts:253-258`, `conformance/fixtures/combat.gen.test.ts:282-283` — set the manually-constructed PCs' ids.

**Add (tests):**
- `src/lib/authoring/assembler.test.ts` — id-assignment + determinism unit tests (Tasks 1, 2, 5).
- `src/lib/authoring/orchestration.test.ts` — PC-id unit test (Task 3).
- A regenerate-twice stability check (Task 5).

**Regenerate:** all gen-produced `conformance/fixtures/*` goldens + start snapshots (Task 4).

**Rust core / `generateId` / entity constructors:** unchanged.

---

### Task 1: Content-derived ids for uniquely-keyed + composite entities

Assign ids in the assembler for campaign, caches, mobs, rooms, npcs, exits, and scenes. (Items are Task 2; PCs are Task 3.)

**Files:**
- Modify: `src/lib/authoring/assembler.ts:174-303`
- Test: `src/lib/authoring/assembler.test.ts`

**Interfaces:**
- Consumes: `assemble(desc, registry) -> { campaign, rooms }` (unchanged signature); `baseDesc(over)` test helper (assembler.test.ts:26).
- Produces: after `assemble`, `campaign.id === \`campaign:${title}\``, `room.id === \`room:${name}\``, `mob.id === \`mob:${name}\``, `cache.id === \`cache:${name}\``, `npc.id === \`npc:${name}\``, `exit.id === \`exit:${[from,to].sort().join("|")}\``, `scene.id === \`scene:${room}:${key}:${phase}\``.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/authoring/assembler.test.ts` (inside the `describe("assemble", …)` block):

```ts
it("assigns content-derived ids, stable across builds", () => {
  const desc = baseDesc({
    mobs: [{ name: "goblin", stats: stats(), room: "next", drops: [] }],
    caches: [{ name: "vein", room: "next", materials: {} }],
    scenes: [],
  });
  const a = assemble(desc, registry);
  expect(a.campaign.id).toBe("campaign:Crypt");
  expect(a.rooms.get("start")!.id).toBe("room:start");
  expect(a.rooms.get("next")!.id).toBe("room:next");
  expect(a.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
  expect([...a.rooms.get("next")!.materials.values()][0]!.id).toBe("cache:vein");
  const exit = a.rooms.get("start")!.exits.get(Directions.North)!;
  expect(exit.id).toBe("exit:next|start"); // author names, sorted
  // Stable across a second, independent build (no shared counter).
  const b = assemble(desc, registry);
  expect(b.rooms.get("start")!.id).toBe("room:start");
  expect(b.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/lib/authoring/assembler.test.ts -t "content-derived"`
Expected: FAIL — ids are current uuids, not `campaign:Crypt`/`room:start`/etc.

- [ ] **Step 3: Implement the id assignments**

In `src/lib/authoring/assembler.ts`, add casts import at the top (merge with existing imports):

```ts
import type { CampaignId } from "../campaign";
import type { RoomId } from "../room";
import type { CharacterId } from "../character/character";
import type { MaterialCacheId } from "../material-cache";
import type { ExitId } from "../exit";
import type { SceneId } from "../scene";
```

Assign ids at each construction site:

Campaign — right after the `new Campaign({…})` block (after line 187):
```ts
  campaign.id = `campaign:${desc.title}` as CampaignId;
```

Caches — inside the loop (replace lines 200-202):
```ts
  for (const c of desc.caches) {
    const cache = new MaterialCache({ contents: c.materials });
    cache.id = `cache:${c.name}` as MaterialCacheId;
    caches.set(c.name, cache);
  }
```

Mobs — inside the loop (the mob id; drops are Task 2). Replace lines 210-215:
```ts
  for (const m of desc.mobs) {
    const mob = new Mob({ campaign, name: m.name, stats: m.stats, inventorySlots: m.inventorySlots ?? 2, actionsPerRound: m.actionsPerRound ?? 2, drops: (m.drops ?? []).map((k) => registry.item(k)()), baseEscapeChance: m.baseEscapeChance, materialDrops: m.materialDrops, lightAverse: m.lightAverse, naturalAttack: m.naturalAttack });
    mob.id = `mob:${m.name}` as CharacterId;
    mobs.set(m.name, mob);
  }
```

Rooms — inside the loop (the room id; lights are Task 2). After `rooms.set(r.name, new Room({…}))`, assign; restructure lines 222-234 to capture the room:
```ts
    const room = new Room({
      name: r.name, description: r.description, loot: roomLoot, exits: NO_EXITS,
      materials: roomCaches, spawnModifier: r.spawnModifier ?? 1, dark: r.dark ?? false, lightSources: lights,
    });
    room.id = `room:${r.name}` as RoomId;
    rooms.set(r.name, room);
```

NPCs — after `new NonPlayerCharacter({…})` (line 248-255), before the `if (n.room …)`:
```ts
    npc.id = `npc:${n.name}` as CharacterId;
```

Exits — after each `from.addExit(…)` call, set the created exit's id (the exit lives at `from.exits.get(e.direction)`; bidirectional exits share one object). Add after both branches inside the exits loop (after line 288):
```ts
    const exit = from.exits.get(e.direction)!;
    exit.id = `exit:${[e.from, e.to].sort().join("|")}` as ExitId;
```

Scenes — capture the Scene and assign before/after `registerScene` (replace lines 294-302):
```ts
    const scene = new Scene<never>({
      phase: s.phase ?? "enter", preconditions: behavior.preconditions,
      script: behavior.script, initialState: (s.initialState ?? {}) as never, behaviorKey: s.key,
    });
    scene.id = `scene:${s.room}:${s.key}:${s.phase ?? "enter"}` as SceneId;
    rooms.get(s.room)!.registerScene(scene);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run src/lib/authoring/assembler.test.ts`
Expected: PASS (new test + existing assembler tests still green — they assert counts/relationships, not id format).

- [ ] **Step 5: Commit**

```bash
git add src/lib/authoring/assembler.ts src/lib/authoring/assembler.test.ts
git commit -m "refactor(authoring): content-derived ids for template entities (sub-plan 4c-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Content-derived multi-instance item ids

Assign ids to the items created inside loot contents, mob drops, and room light sources — from the parent's content-derived id + role + array index.

**Files:**
- Modify: `src/lib/authoring/assembler.ts:204-235`
- Test: `src/lib/authoring/assembler.test.ts`

**Interfaces:**
- Consumes: Task 1's parent ids (`loot:${name}`, `mob:${name}`, `room:${name}`).
- Produces: loot content item ids `loot:${name}:item#${i}`, mob drop item ids `mob:${name}:drop#${i}`, room light item ids `room:${name}:light#${i}`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/authoring/assembler.test.ts`:

```ts
it("assigns content-derived item ids incl. repeated keys", () => {
  const { rooms } = assemble(baseDesc({
    loot: [{ name: "chest", room: "next", items: ["coin-item", "coin-item"] }],
    mobs: [{ name: "goblin", stats: stats(), room: "next", drops: ["coin-item"] }],
    rooms: [{ name: "start", description: "e" }, { name: "next", description: "n", lights: ["coin-item"] }],
    exits: [{ from: "start", direction: Directions.North, to: "next" }],
  }), registry);
  const next = rooms.get("next")!;
  const chest = [...next.loot.values()][0]!;
  expect(chest.contents.map((i) => i.id)).toEqual(["loot:chest:item#0", "loot:chest:item#1"]);
  const goblin = next.occupants.find((o) => o.name === "goblin")!;
  expect(goblin.inventory.items[0]!.id).toBe("mob:goblin:drop#0");
  expect([...next.lightSources][0]!.id).toBe("room:next:light#0");
  // all ids unique
  const all = [...chest.contents.map((i) => i.id), goblin.inventory.items[0]!.id, [...next.lightSources][0]!.id];
  expect(new Set(all).size).toBe(all.length);
});
```

(If `next.lightSources` is not directly iterable, read it via the room's public light-source accessor used elsewhere in the tests; adjust the accessor to match, keeping the id assertions.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/lib/authoring/assembler.test.ts -t "item ids"`
Expected: FAIL — item ids are uuids.

- [ ] **Step 3: Implement item id assignment**

In `src/lib/authoring/assembler.ts`, assign each item's id right after it is created, using the parent's content-derived id.

Loot contents (replace the `contents:` map at line 206):
```ts
  for (const l of desc.loot) {
    const lootId = `loot:${l.name}`;
    const contents = l.items.map((k, i) => {
      const it = registry.item(k)();
      it.id = `${lootId}:item#${i}` as ItemId;
      return it;
    });
    const box = new Loot({ description: l.description ?? l.name, contents });
    box.id = lootId as LootId;
    loot.set(l.name, box);
  }
```

Mob drops (in the mob loop from Task 1, replace the `drops:` map):
```ts
    const mobId = `mob:${m.name}`;
    const drops = (m.drops ?? []).map((k, i) => {
      const it = registry.item(k)();
      it.id = `${mobId}:drop#${i}` as ItemId;
      return it;
    });
    const mob = new Mob({ campaign, name: m.name, stats: m.stats, inventorySlots: m.inventorySlots ?? 2, actionsPerRound: m.actionsPerRound ?? 2, drops, baseEscapeChance: m.baseEscapeChance, materialDrops: m.materialDrops, lightAverse: m.lightAverse, naturalAttack: m.naturalAttack });
    mob.id = mobId as CharacterId;
    mobs.set(m.name, mob);
```

Room lights (in the room loop from Task 1, replace the `lights` line):
```ts
    const roomId = `room:${r.name}`;
    const lights = (r.lights ?? []).map((k, i) => {
      const it = registry.item(k)();
      it.id = `${roomId}:light#${i}` as ItemId;
      return it;
    });
```
and use `room.id = roomId as RoomId;` for the room id (replacing Task 1's `\`room:${r.name}\`` literal with the `roomId` variable for DRYness).

Add `import type { ItemId } from "../inventory";` and `import type { LootId } from "../loot";` to the assembler imports.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run src/lib/authoring/assembler.test.ts`
Expected: PASS (new test + Task 1 test + existing tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/authoring/assembler.ts src/lib/authoring/assembler.test.ts
git commit -m "refactor(authoring): content-derived multi-instance item ids (sub-plan 4c-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Player-character ids (orchestration + manual fixtures)

Assign `player:${name}` to PlayerCharacters at their construction sites.

**Files:**
- Modify: `src/lib/authoring/orchestration.ts:73`
- Modify: `conformance/fixtures/afflictions.gen.test.ts:253,258`, `conformance/fixtures/combat.gen.test.ts:282` (+ its Ben construction)
- Test: `src/lib/authoring/orchestration.test.ts`

**Interfaces:**
- Consumes: `startSession(builder, { players, gm })` (unchanged signature).
- Produces: each PlayerCharacter created by `startSession` (and by the two manual fixtures) has `id === \`player:${name}\``.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/authoring/orchestration.test.ts`:

```ts
it("assigns content-derived player ids distinct from a same-named mob", () => {
  const reg = defineRegistry({ items: {} });
  const builder = authorTemplate("T", reg)
    .room("hall", { description: "a hall" })
    .startRoom("hall");
  const campaign = startSession(builder, { players: [{ name: "Ada" }], gm: 0 });
  expect(campaign.party[0]!.id).toBe("player:Ada");
});
```

(Use the imports already present in `orchestration.test.ts`; add `defineRegistry`/`authorTemplate` imports if missing, mirroring `assembler.test.ts:4-5`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/lib/authoring/orchestration.test.ts -t "player ids"`
Expected: FAIL — PC id is a uuid.

- [ ] **Step 3: Implement**

`src/lib/authoring/orchestration.ts` — in the `for (const p of players)` loop (after line 73 `const pc = new PlayerCharacter({ campaign, name: p.name });`):
```ts
    pc.id = `player:${p.name}` as CharacterId;
```
Add `import type { CharacterId } from "../character/character";` if not already imported.

`conformance/fixtures/afflictions.gen.test.ts` — after the two PC constructions (lines 253, 258):
```ts
  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  // …
  const ben = new PlayerCharacter({ campaign, name: "Ben", rng });
  ben.id = "player:Ben" as CharacterId;
```

`conformance/fixtures/combat.gen.test.ts` — after each PC construction (Ada at line 282 and Ben):
```ts
  const ada = new PlayerCharacter({ campaign, name: "Ada", rng });
  ada.id = "player:Ada" as CharacterId;
  // … and for Ben:
  ben.id = "player:Ben" as CharacterId;
```
Add `import type { CharacterId } from "wickedways/lib/character/character";` (match the fixture's existing import path style) to both fixtures if not present.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run src/lib/authoring/orchestration.test.ts`
Expected: PASS. (The fixture edits produce no golden change yet — goldens regenerate in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/authoring/orchestration.ts src/lib/authoring/orchestration.test.ts conformance/fixtures/afflictions.gen.test.ts conformance/fixtures/combat.gen.test.ts
git commit -m "refactor(authoring): content-derived player-character ids (sub-plan 4c-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Regenerate all fixtures + full gate green

Regenerate every gen-produced fixture with content-derived ids and prove nothing but ids changed and every gate is green — with zero Rust changes.

**Files:**
- Regenerate: all `conformance/fixtures/*.json` gen outputs.

**Interfaces:**
- Consumes: Tasks 1-3 (all genesis entities now get content-derived ids).

- [ ] **Step 1: TS unit suite green (pre-regen)**

Run: `pnpm test`
Expected: PASS — no `src/` test asserts uuid id format (they use `generateId` for opaque ids, which is unchanged). Fix any that break ONLY by updating an id-format assertion to the content-derived value; never by reverting an id assignment.

- [ ] **Step 2: Regenerate fixtures**

Run: `pnpm run fixtures:gen`
Expected: all gen fixtures rewrite their `*.start.snapshot.json`, `*.catalog.json` (if id-bearing), and `*.golden.json` with content-derived ids; no self-validation throw.

- [ ] **Step 3: Prove only ids changed (semantic-inertness)**

Run (per changed golden, or scripted across `conformance/fixtures/*.json`):
```bash
git show HEAD:conformance/fixtures/turn-movement.golden.json | sed -E 's/(room|mob|loot|cache|npc|exit|scene|player|campaign):[^"]*|[0-9a-f]{8}-[0-9a-f-]{27}/ID/g' > /tmp/old.json
sed -E 's/(room|mob|loot|cache|npc|exit|scene|player|campaign):[^"]*|[0-9a-f]{8}-[0-9a-f-]{27}/ID/g' conformance/fixtures/turn-movement.golden.json > /tmp/new.json
diff /tmp/old.json /tmp/new.json
```
Expected: **empty diff** for every golden — proving only id strings changed and no field/mechanic moved. Investigate any non-empty diff before proceeding.

- [ ] **Step 4: No uuid stragglers**

Run: `grep -rlE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' conformance/fixtures/*.json`
Expected: **no matches** — every id is content-derived. If a file still contains a uuid, an entity-construction site was missed; add its content-derived id assignment (and note it), then re-run `fixtures:gen`.

- [ ] **Step 5: Full gate green (no Rust changes)**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 — Rust replays the regenerated content-derived-id snapshots and matches every golden (ids are opaque to Rust), `cargo test --workspace` green, no_std build clean, `bindings:check` clean (no binding change — id fields are already `string`). Confirm `git status` shows **no** changes under `crates/`.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures
git commit -m "test(conformance): regenerate all fixtures with content-derived ids (sub-plan 4c-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Stability + multi-campaign determinism tests + docs

Lock in the two guarantees (idempotent regeneration; multi-campaign independence) and document the scheme.

**Files:**
- Add: a stability check (script or test) + `src/lib/authoring/assembler.test.ts` multi-campaign test.
- Modify: `README.md` (id-scheme note).

- [ ] **Step 1: Write the multi-campaign determinism test**

Add to `src/lib/authoring/assembler.test.ts`:

```ts
it("derives independent, non-interfering ids across campaigns in one process", () => {
  const d1 = baseDesc({ mobs: [{ name: "goblin", stats: stats(), room: "next", drops: [] }] });
  const d2 = baseDesc({ title: "Other", rooms: [{ name: "cell", description: "c" }], startRoom: "cell", exits: [] });
  const a1 = assemble(d1, registry);
  const a2 = assemble(d2, registry);           // second campaign built after the first
  const a1again = assemble(d1, registry);      // rebuild the first, later still
  expect(a1.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
  expect(a2.campaign.id).toBe("campaign:Other");
  expect(a2.rooms.get("cell")!.id).toBe("room:cell");
  // First campaign's ids are identical no matter how many campaigns were built in between.
  expect(a1again.rooms.get("start")!.id).toBe("room:start");
  expect(a1again.rooms.get("next")!.occupants[0]!.id).toBe("mob:goblin");
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run src/lib/authoring/assembler.test.ts -t "non-interfering"`
Expected: PASS (no shared counter → later builds don't shift earlier ids).

- [ ] **Step 3: Add the regenerate-twice stability check**

Add a script to `package.json` scripts:
```json
"fixtures:stable": "pnpm run fixtures:gen && git diff --exit-code -- conformance/fixtures"
```
This regenerates once more and asserts a clean diff (the working tree already holds the Task-4 regenerated goldens, so a second regeneration must produce byte-identical output).

- [ ] **Step 4: Run the stability check**

Run: `pnpm run fixtures:stable`
Expected: EXIT 0 — `git diff --exit-code` clean, proving `fixtures:gen` is idempotent (the UUID-churn debt is retired).

- [ ] **Step 5: Docs note**

Add a short subsection to `README.md` (near the serialization/ids discussion): entity ids are content-derived — `kind:name` for authored entities, `${parentId}:role#index` for multi-instance items, `player:name` for PCs, `campaign:title` (caller may override for multi-campaign uniqueness); runtime-minted entities (sub-plan 4c-2 onward) derive from mint context. This makes ids deterministic, readable, and safe for multiple live campaigns in one process.

- [ ] **Step 6: Commit**

```bash
git add src/lib/authoring/assembler.test.ts package.json README.md
git commit -m "test+docs: id determinism (multi-campaign + regenerate-twice) + scheme note (sub-plan 4c-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **`generateId`/`uuid`/entity constructors are intentionally untouched.** The uuid a constructor mints is overwritten by the caller's content-derived assignment and never reaches a snapshot. Do not "clean up" by removing the constructor's id generation — that would break `src/` unit tests that call `generateId` for opaque ids and is out of scope.
- **Tasks 1-3 leave `test:conformance` green** even before regeneration: it replays the *committed* (uuid) goldens through *unchanged* Rust, which still match. Only Task 4 regenerates goldens.
- **Any uuid remaining in a regenerated golden (Task 4 Step 4) means a construction site was missed** — find it and assign a content-derived id; don't suppress the check.
- **Zero Rust changes.** If `checks:phase3` is red after regeneration, the divergence is a missed/incorrect id assignment on the TS side (or a genuine golden problem), not a Rust bug — fix the TS assignment and regenerate; never hand-edit a golden.
