/**
 * Sees-in-dark golden generator — run once to write the committed fixture files.
 *
 * Proves the POSITIVE path of the dark-visibility gate: a `seesInDark` attacker
 * lands an attack in an UNLIT room. TS oracle: `requireVisibleTarget`
 * (character.ts:266-272) called from `attack` (combatant.ts:51). Rust:
 * `require_visible_target` (combat.rs:144-153) + `sees_in_dark` (view.rs:185-187).
 * The NEGATIVE path ("Cannot attack in the dark" for a non-seeing actor) throws,
 * which is not representable in a golden step stream — it stays covered by Rust
 * unit tests.
 *
 * ATTACKER CHOICE: mobs do not act through the Phase-1 replay command surface
 * (commands drive `campaign.activeCharacter`, always a PC — see the note on
 * `sees_in_dark` in view.rs). So the light-averse seesInDark attacker here is a
 * PLAYER-controlled character: `SeesInDarkPlayer` overrides BOTH `lightAverse`
 * and `seesInDark`, mirroring the Mob contract (`mob.ts:102-108`, where
 * `seesInDark === lightAverse`) — which is exactly the model Rust applies to
 * every character (`sees_in_dark` reads the snapshot's `lightAverse` flag).
 * The PC attacks a plain mob in a dark room; the attack succeeds because
 * `seesInDark` bypasses the `!room.isLit` visibility gate.
 *
 * NO ENCOUNTER FORMATION is registered (and baseEncounterChance is 0): a
 * registered formation would make the setup `pc.move` seating consume a spawn
 * threshold-roll rng draw before the genesis snapshot, offsetting the rng
 * stream of this value-dependent combat fixture.
 *
 * SEED is fixed (no brute-force seed search like combat/mob-defeat): this
 * fixture draws ZERO rng — the PC has full stats so no affliction ever
 * latches (no clear rolls at startTurn), the encounter table is empty, and
 * the mob never acts. All self-validations are deterministic hard throws.
 *
 * The start snapshot is serialized AFTER the dagger is equipped but BEFORE the
 * first command. No rng is drawn during setup.
 *
 * Writes:
 *   - sees-in-dark.start.snapshot.json  (serialized genesis state, pre-command)
 *   - sees-in-dark.catalog.json         ({ items, aliases } Rust Catalog shape)
 *   - sees-in-dark.golden.json          ({ seed, commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * Interface contract with the Rust replay: each object in `golden.commands`
 * deserializes into the Rust `Command` enum
 * (#[serde(tag="kind", rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "attack", "targetId": "<CharacterId>" }
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { structuralClone } from "./gen-helpers.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import type { CharacterId } from "wickedways/lib/character/character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind, EquipmentSlot } from "wickedways/lib/equipment";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { Campaign } from "wickedways/lib/campaign";
import type { CharacterSnapshot } from "wickedways/lib/serialization/types";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

/** Dagger: weapon, Health+3, maxDurability 5 (never breaks in this short stream). */
const DAGGER_KEY = "items/dagger";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [DAGGER_KEY]: ["dagger", "iron dagger"],
};

// ─── LightAverse + seesInDark player subclass ────────────────────────────────
//
// Unlike combat.gen's LightAversePlayer (which only overrides `lightAverse` for
// the lit-room damage amplification), this subclass ALSO overrides `seesInDark`,
// mirroring the Mob contract (mob.ts:102-108: seesInDark === lightAverse). That
// is the exact semantics Rust applies to every character: `sees_in_dark`
// (view.rs:185-187) reads the snapshot's `lightAverse` flag.

class SeesInDarkPlayer extends PlayerCharacter {
  override get seesInDark(): boolean {
    return true;
  }

  protected override get lightAverse(): boolean {
    return true;
  }

  protected override serializeExtra(snap: CharacterSnapshot): void {
    super.serializeExtra(snap);
    snap.lightAverse = true;
  }
}

// ─── Item factories ───────────────────────────────────────────────────────────

const noop = () => {};

/** Iron dagger: weapon targeting Health, maxDurability 5. */
function makeDagger(): Item {
  return new Item({
    descriptor: {
      behaviorKey: DAGGER_KEY,
      name: "Iron Dagger",
      type: ItemType.Weapon,
      recipe: { item: 1 },
      modifier: 3,
      stat: StatType.Health,
      maxDurability: 5,
      slot: SlotKind.Hand,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildItemRegistry() {
  return defineRegistry({
    items: {
      [DAGGER_KEY]: makeDagger,
    },
  });
}

// ─── Catalog exporter (verbatim from mob-defeat.gen.test.ts) ─────────────────

function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    type: item.type,
    stat: item.stat,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    ...(item.slot !== undefined ? { slot: item.slot } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

function buildCatalog(
  registry: ReturnType<typeof buildItemRegistry>,
  itemKeys: string[],
  aliases: Record<string, string[]>,
): { items: Record<string, unknown>; aliases: Record<string, string[]> } {
  const items: Record<string, unknown> = {};
  for (const key of itemKeys) {
    const factory = registry.item(key);
    const instance = factory();
    items[key] = itemToCatalogEntry(instance);
  }
  return { items, aliases };
}

// ─── ViewModel projection helper (verbatim from mob-defeat.gen.test.ts) ──────

function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]>,
  opened: ReadonlySet<string>,
) {
  const full = view(campaign, aliases, opened);

  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  const { locationName: _locName, ...statusRest } = full.status as { locationName?: unknown; [k: string]: unknown };

  return {
    room: roomRest,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: statusRest,
    outcome: full.outcome,
    finished: full.finished,
  };
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────
//
// Cellar (start, dark: true — no light sources anywhere, so isLit === false).
// Player: Ben (SeesInDarkPlayer; health=10, sanity=10, energy=10), Iron Dagger.
// Ghoul (mob, plain — the TARGET, not the seeing actor): health=4, sanity=4,
// energy=4, pre-placed in the Cellar via the assembler's mobs list (room-origin;
// NOT an encounter formation — see the header note on rng offsets).
//
// Damage for the one dagger attack in the dark (no armor on Ghoul; the dark
// room means no lit-room lightAverse amplification on either side):
//   attackStrength = 3 (dagger modifier)
//   mitigator = Ghoul's Sanity (Health is mitigated by Sanity) = 4
//   damage = 3 * max(0, 10 - 4) * 0.2 = 3 * 1.2 = 3.6
//   Ghoul health: 4 - 3.6 = 0.4 (fractional, still standing — no KO machinery)

function buildSeesInDarkCampaign(rng: () => number) {
  const registry = buildItemRegistry();

  const template = authorTemplate("Sees In Dark (conformance)", registry, {
    rng,
    maxRounds: 20,
    baseEncounterChance: 0,
  })
    .archetype({
      id: "fighter",
      name: "Fighter",
      baseStats: {
        [StatType.Health]: 10,
        [StatType.Sanity]: 10,
        [StatType.Energy]: 10,
      },
    })
    .room("Cellar", { description: "A pitch-black cellar.", dark: true })
    .startRoom("Cellar")
    .mob("Ghoul", {
      stats: {
        [StatType.Health]: 4,
        [StatType.Sanity]: 4,
        [StatType.Energy]: 4,
      },
      room: "Cellar",
    });

  const { campaign, rooms } = assemble(template.description, template.registry);
  const cellar = rooms.get("Cellar")!;

  const ben = new SeesInDarkPlayer({ campaign, name: "Ben", rng });
  ben.id = "player:Ben" as CharacterId;
  ben.joinCampaign();
  ben.selectArchetype("fighter" as never);
  ben.move(cellar);

  campaign.gm = ben;
  campaign.beginCampaign();

  return { campaign, registry, ben, cellar };
}

// ─── Command types ─────────────────────────────────────────────────────────────

type Command =
  | { kind: "startTurn" }
  | { kind: "attack"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate sees-in-dark golden", () => {
  it("writes the sees-in-dark snapshot, catalog, and golden", () => {
    // Fixed seed: this fixture draws zero rng (see header), so no seed search
    // is needed and every self-validation is a deterministic hard throw.
    const SEED = 1;
    const rng = mulberry32(SEED);
    const { campaign, registry, ben, cellar } = buildSeesInDarkCampaign(rng);

    // ── Equip the dagger ───────────────────────────────────────────────────
    // Equipped during setup (no afflictions → gate allows; no rng drawn; the
    // visibility gate covers attack/loot/harvest only, so equipping in the
    // dark is legal).
    const daggerItem = registry.item(DAGGER_KEY)();
    daggerItem.id = `player:Ben:item#${DAGGER_KEY}` as ItemId;
    ben.addToInventory(daggerItem);
    ben.equip(daggerItem, EquipmentSlot.LeftHand);

    // ── Structural invariants (hard throws) ───────────────────────────────
    if (!cellar.dark) {
      throw new Error("Self-validation: the Cellar must be authored dark.");
    }
    if (cellar.isLit) {
      throw new Error("Self-validation: the Cellar must be genuinely unlit (no light sources).");
    }
    if (!ben.seesInDark) {
      throw new Error("Self-validation: the attacker must have seesInDark === true.");
    }

    // ── Genesis snapshot (pre-command, dagger equipped) ────────────────────
    const start = structuralClone(serializeCampaign(campaign));

    type CharSnap = {
      name: string;
      lightAverse?: boolean;
      stats: Record<string, number>;
      history: Array<{ kind: string; stat?: string }>;
    };
    const benStart = (start.characters as CharSnap[]).find((c) => c.name === "Ben");
    if (benStart?.lightAverse !== true) {
      throw new Error("Self-validation: Ben's genesis snapshot must carry lightAverse: true.");
    }

    // ── Build catalog ──────────────────────────────────────────────────────
    const catalog = buildCatalog(registry, [DAGGER_KEY], ALIASES);

    // ── Cue capture ────────────────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── `opened` set (no loot boxes in this campaign) ─────────────────────
    const opened = new Set<string>();

    // ── Resolve the Ghoul id for the attack command ────────────────────────
    // Mob authored via the assembler's mobs list → id = "mob:Ghoul".
    const GHOUL_ID = "mob:Ghoul";

    // ── The command stream ─────────────────────────────────────────────────
    // Minimal by design: Ben startTurn, then ONE attack on the Ghoul in the
    // dark. The attack succeeding (instead of throwing "Cannot attack in the
    // dark") is the contract under test.
    const commands: Command[] = [
      { kind: "startTurn" },
      { kind: "attack", targetId: GHOUL_ID },
    ];

    // ── Drive the engine directly, capturing per-step state ─────────────────
    const pcNow = () => campaign.activeCharacter;

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "attack": {
          const room = pcNow().currentRoom!;
          const mob = [...room.occupants].find(
            (o) => (o.id as unknown as string) === cmd.targetId,
          );
          if (!mob) {
            throw new Error(`Self-validation: attack target ${cmd.targetId} not in room.`);
          }
          pcNow().attack(mob);
          break;
        }
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: structuralClone(serializeCampaign(campaign)),
        view: structuralClone(viewProjected(campaign, ALIASES, opened)),
      };
    });

    // ── Self-validation (hard throws) ──────────────────────────────────────

    // (a) The room stayed unlit at every step — the attack really happened in
    // the dark.
    for (const [i, s] of steps.entries()) {
      if ((s.view.room as { isLit?: boolean }).isLit !== false) {
        throw new Error(`Self-validation: room must be unlit at step ${i} (view.room.isLit !== false).`);
      }
    }

    // (b) The attack step emitted the attack action cue.
    const attackStep = steps[steps.length - 1]!;
    const attackCue = attackStep.cues.some(
      (c) => (c as { kind: string; action?: string }).kind === "action"
        && (c as { kind: string; action?: string }).action === "attack",
    );
    if (!attackCue) {
      throw new Error("Self-validation: the attack step must emit an { kind: 'action', action: 'attack' } cue.");
    }

    // (c) The attack LANDED despite the dark: the Ghoul took mitigated Health
    // damage (4 → 0.4, fractional, still standing) and has a takeDamage entry.
    const ghoul = (attackStep.snapshot.characters as CharSnap[]).find((c) => c.name === "Ghoul");
    if (!ghoul) throw new Error("Self-validation: Ghoul missing from the attack-step snapshot.");
    const ghoulHealth = ghoul.stats["health"];
    if (ghoulHealth === undefined || ghoulHealth >= 4 || ghoulHealth <= 0) {
      throw new Error(
        `Self-validation: Ghoul health must have dropped below 4 but stay above 0 (got ${String(ghoulHealth)}).`,
      );
    }
    if (Number.isInteger(ghoulHealth)) {
      throw new Error(
        `Self-validation: Ghoul health should be fractional after mitigation (got ${String(ghoulHealth)}).`,
      );
    }
    const tookHealthDamage = ghoul.history.some(
      (h) => h.kind === "takeDamage" && h.stat === StatType.Health,
    );
    if (!tookHealthDamage) {
      throw new Error("Self-validation: Ghoul must record a takeDamage(health) history entry.");
    }

    // (d) The attacker recorded the attack (identity check that the seeing
    // actor is the light-averse PC).
    const benAfter = (attackStep.snapshot.characters as CharSnap[]).find((c) => c.name === "Ben");
    if (!benAfter?.history.some((h) => h.kind === "attack")) {
      throw new Error("Self-validation: Ben must record the attack in his history.");
    }
    if (benAfter.lightAverse !== true) {
      throw new Error("Self-validation: Ben must still serialize lightAverse: true after the attack.");
    }

    // ── Catalog validation ──────────────────────────────────────────────────
    if (Object.keys(catalog.items).length === 0) {
      throw new Error("Catalog items is empty — no item factories were exported.");
    }
    for (const [key, descriptor] of Object.entries(catalog.items)) {
      const d = descriptor as Record<string, unknown>;
      for (const field of ["recipe", "teaches", "immunities", "grantsImmunity"]) {
        if (!(field in d)) {
          throw new Error(`Catalog item '${key}' is missing required inert field '${field}'.`);
        }
      }
    }

    // ── Write files ─────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "sees-in-dark.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "sees-in-dark.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "sees-in-dark.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ───────────────────────────────────────────────────────
    console.log(`[sees-in-dark] SEED=${SEED} steps=${steps.length}`);
  });
});
