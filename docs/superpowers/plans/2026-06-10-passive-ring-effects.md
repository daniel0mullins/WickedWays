# Passive Ring Effects (④b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worn accessories (rings) passively buff the wearer's stats — combat mitigation and status thresholds read an **effective** stat (base + equipped-accessory modifiers) without ever mutating the base.

**Architecture:** Add one compute-on-read method, `Character.effectiveStat(stat)`, that sums the `modifier` of equipped `accessory` items targeting that stat onto the base stat. Reroute exactly two existing reads through it: the mitigator lookup in `takeDamage` (with a use-site clamp so an over-cap mitigator can't produce negative/healing damage) and the threshold reads in `#resolveStatuses` (restructured so base flooring stays unconditional while status flags read effective). Status stays lazy — equip/unequip do not re-resolve.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, typescript-eslint (recommendedTypeChecked).

**Design spec:** `docs/superpowers/specs/2026-06-10-passive-ring-effects-design.md`

This is sub-project **④b**, the second and final plan of ④. It depends on ④a (the `accessory` item type, the `Finger` slot kind, `Character.equip`/`unequip`, and the four-finger slot cap), which is merged to `main`.

---

## File Structure

- `src/lib/character/character.ts` — **modify.** Add `effectiveStat` to `ICharacter` and `Character`; reroute the mitigator read in `takeDamage`; restructure `#resolveStatuses` to floor base unconditionally and read effective for status flags. This is the only production file touched.
- `src/lib/character/character.test.ts` — **modify.** Unit tests for `effectiveStat`, the mitigation reroute, the status reroute, plus an integration seam (mitigation + status off effective, the four-finger cap, losslessness).

Notes for the implementer:
- Existing constants in `character.ts`: `MAX_STAT = 10`, `MITIGATION_PER_POINT = 0.2`, and `MitigatorStatType` (imported from `./stats`): Health←Sanity, Sanity←Energy, Energy←Health.
- The test file already has these module-scope helpers (from ③/④a): `makeStats` (defaults all three stats to 10), `makeCharacter({ stats?, inventorySlots?, actionsPerRound? })`, `makeGear({ type?, slot?, stat?, modifier?, equippable?, name?, twoHanded? })`, and `type ItemDescriptor`. Reuse them — do **not** redeclare.
- To equip a ring in a test: push it into `hero.inventory.items` then call `hero.equip(ring)` (equip auto-assigns a free finger slot; pushing directly to `inventory.items` bypasses slot-count limits, as the ④a tests do).
- A running note on Vitest `-t`: it treats the pattern as a regex, so do not put `()` in a `-t` filter. The steps below run whole test files.

Commit footer for every commit:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## Task 1: `effectiveStat` method

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/character.test.ts`, add a new `describe` block inside the top-level `describe("Character", …)` (next to the other method describes such as `describe("takeDamage", …)`):

```ts
  describe("effectiveStat", () => {
    function makeRing(stat: StatType, modifier: number, name = "Ring"): Item {
      return makeGear({ type: "accessory", slot: "finger", stat, modifier, name });
    }
    function heroWearing(rings: Item[], stats?: Partial<Stats>) {
      const hero = makeCharacter({ stats });
      for (const ring of rings) {
        hero.inventory.items.push(ring);
        hero.equip(ring);
      }
      return hero;
    }

    it("returns the base stat when no accessories are worn", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 7 } });
      expect(hero.effectiveStat(StatType.Sanity)).toBe(7);
    });

    it("adds an equipped accessory's modifier for the matching stat", () => {
      const hero = heroWearing([makeRing(StatType.Sanity, 2)], { [StatType.Sanity]: 6 });
      expect(hero.effectiveStat(StatType.Sanity)).toBe(8);
    });

    it("sums multiple matching rings additively", () => {
      const hero = heroWearing(
        [makeRing(StatType.Sanity, 2, "A"), makeRing(StatType.Sanity, 3, "B")],
        { [StatType.Sanity]: 5 },
      );
      expect(hero.effectiveStat(StatType.Sanity)).toBe(10);
    });

    it("ignores accessories targeting a different stat", () => {
      const hero = heroWearing([makeRing(StatType.Health, 4)], { [StatType.Sanity]: 6 });
      expect(hero.effectiveStat(StatType.Sanity)).toBe(6);
    });

    it("ignores accessories that are in inventory but not equipped", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 6 } });
      const ring = makeRing(StatType.Sanity, 2);
      hero.inventory.items.push(ring); // present but never equipped
      expect(hero.effectiveStat(StatType.Sanity)).toBe(6);
    });

    it("does not count non-accessory items with the same stat (no double-count)", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 6 } });
      const weapon = makeGear({ type: "weapon", slot: "hand", stat: StatType.Sanity, modifier: 5 });
      hero.inventory.items.push(weapon);
      hero.equip(weapon);
      expect(hero.effectiveStat(StatType.Sanity)).toBe(6);
    });

    it("never mutates the base stat", () => {
      const hero = heroWearing([makeRing(StatType.Sanity, 2)], { [StatType.Sanity]: 6 });
      hero.effectiveStat(StatType.Sanity);
      expect(hero.stats[StatType.Sanity]).toBe(6);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — `hero.effectiveStat is not a function`.

- [ ] **Step 3: Implement in `src/lib/character/character.ts`**

(a) Add the method to the `ICharacter` interface, immediately after the `craft` declaration (which ends the methods block, before the `// ### Events` section):

```ts
  /**
   * The character's effective value for `stat`: the base stat plus the `modifier`
   * of every equipped accessory targeting it. Drives damage mitigation and status
   * thresholds; never mutates the base. Uncapped — the use site clamps.
   */
  effectiveStat: (stat: StatType) => number;
```

(b) Add the method to the `Character` class, immediately before the `takeDamage` method:

```ts
  effectiveStat(stat: StatType): number {
    return this.#inventory.items.reduce(
      (total, item) =>
        item.properties.equipped && item.type === "accessory" && item.stat === stat
          ? total + item.modifier
          : total,
      this.stats[stat],
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts` → PASS.
Then `npx tsc --noEmit` and `npx eslint src/lib/character/character.ts src/lib/character/character.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
feat: Character.effectiveStat sums equipped accessory modifiers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Route damage mitigation through `effectiveStat`

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/character.test.ts`, add a new `describe` block inside `describe("Character", …)`:

```ts
  describe("takeDamage with accessory mitigation", () => {
    function ringFor(stat: StatType, modifier: number): Item {
      return makeGear({ type: "accessory", slot: "finger", stat, modifier });
    }

    it("a ring on the mitigator stat reduces incoming damage", () => {
      // Health is mitigated by Sanity. Base sanity 5 => (10-5)*0.2 = 1 => 5 damage.
      // A +3 Sanity ring => effective 8 => (10-8)*0.2 = 0.4 => 2 damage.
      const hero = makeCharacter({ stats: { [StatType.Health]: 10, [StatType.Sanity]: 5 } });
      const ring = ringFor(StatType.Sanity, 3);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(5);

      expect(hero.stats[StatType.Health]).toBeCloseTo(8); // 10 - 2
    });

    it("an over-cap mitigator floors the multiplier at 0 — full absorption, never healing", () => {
      // Base sanity 9 + ring 5 => effective 14 => (10-14) clamped to 0 => 0 damage.
      const hero = makeCharacter({ stats: { [StatType.Health]: 6, [StatType.Sanity]: 9 } });
      const ring = ringFor(StatType.Sanity, 5);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(10);

      expect(hero.stats[StatType.Health]).toBeCloseTo(6); // unchanged, NOT increased
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — without the reroute, the +mitigator ring is ignored, so the first test sees 5 damage (health 5, not 8); without the clamp, the over-cap test would compute negative damage (health > 6).

- [ ] **Step 3: Implement in `src/lib/character/character.ts`**

In `takeDamage`, the current mitigation lines read:

```ts
    const mitigator = this.stats[MitigatorStatType[attackStat]];
    const damageMultiplier = (MAX_STAT - mitigator) * MITIGATION_PER_POINT;
```

Replace them with the effective read plus the use-site clamp:

```ts
    const mitigator = this.effectiveStat(MitigatorStatType[attackStat]);
    const damageMultiplier = Math.max(0, MAX_STAT - mitigator) * MITIGATION_PER_POINT;
```

Leave everything else in `takeDamage` unchanged — armor subtraction, armor wear, the application of `finalAttackStrength` to the **base** stat (`this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength`), the `#resolveStatuses()` call, and `recordAction`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts` → PASS (the new tests **and** the pre-existing `describe("takeDamage", …)` tests, which use no accessories so `effectiveStat === stats` and `Math.max(0, …)` is a no-op for base stats in `[0, 10]`).
Then `npx tsc --noEmit` and `npx eslint src/lib/character/character.ts src/lib/character/character.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
feat: damage mitigation reads effective mitigator stat (clamped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Route status thresholds through `effectiveStat`

Restructure `#resolveStatuses` so base flooring stays unconditional while the KO/Panic/Fear/Confused flags read the effective stat. Status remains lazy (equip/unequip are unchanged and do not call `#resolveStatuses`).

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/character.test.ts`, add a new `describe` block inside `describe("Character", …)`:

```ts
  describe("status thresholds read the effective stat (lazy)", () => {
    function ringFor(stat: StatType, modifier: number): Item {
      return makeGear({ type: "accessory", slot: "finger", stat, modifier });
    }

    it("a +Health ring staves off KO when base health hits 0", () => {
      // Sanity 0 => health multiplier (10-0)*0.2 = 2; 2 damage * 2 = 4 vs 2 health => base floored to 0.
      const hero = makeCharacter({ stats: { [StatType.Health]: 2, [StatType.Sanity]: 0 } });
      const ring = ringFor(StatType.Health, 3);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(2);

      expect(hero.stats[StatType.Health]).toBe(0);     // base floored
      expect(hero.status).not.toContain(Status.KO);    // effective health = 0 + 3 > 0
    });

    it("removing the life-saving ring re-KOs at the next resolution trigger (lazy)", () => {
      const hero = makeCharacter({ stats: { [StatType.Health]: 2, [StatType.Sanity]: 0 } });
      const ring = ringFor(StatType.Health, 3);
      hero.inventory.items.push(ring);
      hero.equip(ring);
      hero.takeDamage(2);
      expect(hero.status).not.toContain(Status.KO);

      hero.unequip(ring);                               // pure slot op — status not yet refreshed
      hero.startTurn();                                 // next resolution trigger
      expect(hero.status).toContain(Status.KO);         // effective health now 0
    });

    it("a +Sanity ring above the Fear threshold prevents Fear", () => {
      // Base sanity 4 (< 5) would be Fear; +2 ring => effective 6 => no Fear.
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 4 } });
      const ring = ringFor(StatType.Sanity, 2);
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.startTurn();                                 // resolution trigger

      expect(hero.status).not.toContain(Status.Fear);
    });

    it("still floors the base stat at 0 regardless of rings", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 1, [StatType.Energy]: 0 } });
      // Energy 0 => sanity multiplier 2; 5 * 2 = 10 vs sanity 1 => base floored to 0.
      hero.takeDamage(5, StatType.Sanity);
      expect(hero.stats[StatType.Sanity]).toBe(0);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — the first two tests still see KO (status reads base 0), because the threshold reads have not been rerouted yet.

- [ ] **Step 3: Implement in `src/lib/character/character.ts`**

Replace the entire body of `#resolveStatuses` with the restructured version. The current body is:

```ts
  #resolveStatuses() {
    if (this.stats[StatType.Health] <= 0) {
      this.stats[StatType.Health] = 0;
      this.#status.set(Status.KO, true);
    } else {
      this.#status.set(Status.KO, false);
    }

    if (this.stats[StatType.Sanity] <= 0) {
      this.stats[StatType.Sanity] = 0;

      this.#status.set(Status.Panic, true);
      this.#status.set(Status.Fear, false);
    } else if (this.stats[StatType.Sanity] < 5) {
      this.#status.set(Status.Panic, false);
      this.#status.set(Status.Fear, true);
    } else {
      this.#status.set(Status.Panic, false);
      this.#status.set(Status.Fear, false);
    }

    if (this.stats[StatType.Energy] <= 0) {
      this.stats[StatType.Energy] = 0;
      this.#status.set(Status.Confused, true);
    } else if (this.stats[StatType.Energy] > 1) {
      this.#status.set(Status.Confused, false);
    }
  }
```

Replace it with:

```ts
  #resolveStatuses() {
    // Floor each BASE stat at 0, unconditionally. (Previously this happened inside
    // each status branch; it is now decoupled from the status decision so the
    // flags below can read the effective stat without losing the base clamp.)
    this.stats[StatType.Health] = Math.max(0, this.stats[StatType.Health]);
    this.stats[StatType.Sanity] = Math.max(0, this.stats[StatType.Sanity]);
    this.stats[StatType.Energy] = Math.max(0, this.stats[StatType.Energy]);

    // Status flags read the EFFECTIVE stat (base + equipped accessory modifiers),
    // so a worn ring can stave off an affliction; removing it re-applies it at the
    // next resolution. Damage is still applied to the base stat in takeDamage.
    const health = this.effectiveStat(StatType.Health);
    const sanity = this.effectiveStat(StatType.Sanity);
    const energy = this.effectiveStat(StatType.Energy);

    this.#status.set(Status.KO, health <= 0);

    if (sanity <= 0) {
      this.#status.set(Status.Panic, true);
      this.#status.set(Status.Fear, false);
    } else if (sanity < 5) {
      this.#status.set(Status.Panic, false);
      this.#status.set(Status.Fear, true);
    } else {
      this.#status.set(Status.Panic, false);
      this.#status.set(Status.Fear, false);
    }

    // Preserve the existing hysteresis: Confused is set at <= 0 and cleared only
    // above 1, left unchanged in (0, 1].
    if (energy <= 0) {
      this.#status.set(Status.Confused, true);
    } else if (energy > 1) {
      this.#status.set(Status.Confused, false);
    }
  }
```

This is behavior-identical to the original when no accessories are worn (`effectiveStat(x) === stats[x]`), and `Math.max(0, base)` floors exactly when `base <= 0` — the same condition that previously triggered the floor.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts` → PASS (the new status tests **and** all pre-existing status/`takeDamage` tests, which use no accessories).
Then `npx tsc --noEmit` and `npx eslint src/lib/character/character.ts src/lib/character/character.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
feat: status thresholds read effective stat; base floor decoupled

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Integration seam (mitigation + status + four-finger cap + losslessness)

Prove the end-to-end behavior: worn rings drive both mitigation and status off the effective value, ④a's four-finger cap bounds the passive bonus, and the bonus is never baked into the base stat.

**Files:**
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the tests** (these pass once Tasks 1–3 are in, like an integration seam)

In `src/lib/character/character.test.ts`, add a new `describe` block inside `describe("Character", …)`:

```ts
  describe("passive ring effects seam", () => {
    it("worn rings drive both mitigation and status off the effective value", () => {
      // Base sanity 4 would mean Fear and weak mitigation; a +2 Sanity ring => effective 6.
      const hero = makeCharacter({ stats: { [StatType.Health]: 10, [StatType.Sanity]: 4 } });
      const ring = makeGear({ type: "accessory", slot: "finger", stat: StatType.Sanity, modifier: 2 });
      hero.inventory.items.push(ring);
      hero.equip(ring);

      // Mitigation: Health mitigated by effective Sanity 6 => (10-6)*0.2 = 0.8 => 5 * 0.8 = 4.
      hero.takeDamage(5);

      expect(hero.stats[StatType.Health]).toBeCloseTo(6);  // 10 - 4
      expect(hero.status).not.toContain(Status.Fear);      // effective sanity 6 >= 5
    });

    it("the four-finger cap bounds the passive bonus — a fifth ring auto-swaps", () => {
      const hero = makeCharacter({ stats: { [StatType.Sanity]: 2 } });
      const rings = [0, 1, 2, 3, 4].map((n) =>
        makeGear({ type: "accessory", slot: "finger", stat: StatType.Sanity, modifier: 2, name: `R${n}` }),
      );
      rings.forEach((ring) => {
        hero.inventory.items.push(ring);
        hero.equip(ring);
      });

      expect(rings.filter((r) => r.properties.equipped)).toHaveLength(4); // only four finger slots
      expect(hero.effectiveStat(StatType.Sanity)).toBe(10);               // 2 + 4*2, never 2 + 5*2
    });

    it("is lossless — equip, take damage, unequip leaves base reflecting only real damage", () => {
      const hero = makeCharacter({ stats: { [StatType.Health]: 10, [StatType.Sanity]: 5 } });
      // A Health ring does not affect Health's mitigator (Sanity), so it changes no damage here.
      const ring = makeGear({ type: "accessory", slot: "finger", stat: StatType.Health, modifier: 4 });
      hero.inventory.items.push(ring);
      hero.equip(ring);

      hero.takeDamage(5); // sanity 5 => multiplier 1 => 5 damage => base health 5
      expect(hero.stats[StatType.Health]).toBeCloseTo(5);
      expect(hero.effectiveStat(StatType.Health)).toBeCloseTo(9); // 5 + 4 while worn

      hero.unequip(ring);
      expect(hero.stats[StatType.Health]).toBeCloseTo(5);          // base never carried the bonus
      expect(hero.effectiveStat(StatType.Health)).toBeCloseTo(5);  // bonus gone with the ring
    });
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/lib/character/character.test.ts` → PASS. If the four-finger-cap test reports five equipped rings, the bonus isn't bounded — that is a regression in ④a's cap, not a test to weaken.

- [ ] **Step 3: Full suite + static checks**

```
npm run checks
```
Expected: eslint clean, `tsc --noEmit` clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
test: passive ring effects seam — effective stat drives combat and status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Done (④b)

After Task 4: `feature/passive-ring-effects` holds the spec plus four feature commits. Hand off to **superpowers:finishing-a-development-branch** (Push & open PR against `main`). This completes sub-project ④ (equipment slots, handedness, and passive accessory effects).
