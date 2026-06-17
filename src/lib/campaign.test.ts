import { describe, expect, it } from "vitest";

import { Campaign } from "./campaign";
import type { IPlayerCharacter } from "./character/player-character";
import type { Archetype, ArchetypeId } from "./archetype";
import { ProceduralViolation } from "./util";
import { DEPOSIT_MATERIALS } from "./inventory";
import type { CraftingRecipe, RecipeId } from "./crafting";
import type { IItem } from "./inventory";
import { Mob } from "./character/mob";
import { Room } from "./room";
import { type Formation } from "./encounter-table";
import { createKey } from "./inventory";
import { makeStats, type ExitsArg } from "../test-utils";
import { EMIT_CUE, NOTE_ENCOUNTERS } from "./presentation";
import type { PresentationCue } from "./presentation";
import { RECORD_ENCOUNTER } from "./codex";
import type { ICharacter } from "./character/character";
import type { IRoom } from "./room";

// `Campaign` only stores players and compares them by identity, so distinct
// stub objects cast to `IPlayerCharacter` are enough (WeakMap needs objects).
let counter = 0;
function makePlayer(): IPlayerCharacter {
  return { id: `pc-${++counter}`, archetype: {} } as unknown as IPlayerCharacter;
}

function makeRecipe(id: string): CraftingRecipe {
  return {
    id: id as RecipeId,
    materials: { metal: 1 },
    create: () => ({ name: id }) as unknown as IItem,
  };
}

function makeCampaign(
  partySize: number,
  maxRounds?: number,
  begin = true,
): { campaign: Campaign; party: IPlayerCharacter[]; gm: IPlayerCharacter } {
  const campaign = new Campaign("The Haunting", maxRounds);
  const party = Array.from({ length: partySize }, makePlayer);
  for (const player of party) {
    campaign.party.push(player);
  }
  const gm = party[0] ?? makePlayer();
  if (party.length > 0) {
    campaign.gm = gm;
  }
  if (begin) {
    campaign.beginCampaign();
  }
  return { campaign, party, gm };
}

describe("Campaign", () => {
  describe("constructor", () => {
    it("assigns an id, title, party, gm and starts at round zero", () => {
      const { campaign, party, gm } = makeCampaign(2);

      expect(typeof campaign.id).toBe("string");
      expect(campaign.id.length).toBeGreaterThan(0);
      expect(campaign.title).toBe("The Haunting");
      expect(campaign.party).toEqual(party);
      expect(campaign.gm).toBe(gm);
      expect(campaign.round).toBe(0);
    });

    it("defaults maxRounds to 100", () => {
      expect(makeCampaign(1).campaign.maxRounds).toBe(100);
    });

    it("honors a provided maxRounds", () => {
      expect(makeCampaign(1, 7).campaign.maxRounds).toBe(7);
    });
  });

  describe("codex (RECORD_ENCOUNTER seam)", () => {
    it("starts empty", () => {
      const { campaign } = makeCampaign(1);
      expect(campaign.codex.size).toBe(0);
    });

    it("records a party member's encounter with round/character/room stamp", () => {
      const { campaign, party } = makeCampaign(1, undefined, false);
      const by = party[0] as unknown as ICharacter;
      const where = { id: "room-7" } as unknown as IRoom;

      campaign[RECORD_ENCOUNTER]({ kind: "material", material: "metal" }, by, where);

      const entry = campaign.codex.materials[0]!;
      expect(entry.snapshot.type).toBe("metal");
      expect(entry.firstSeen).toEqual({ round: 0, characterId: by.id, roomId: "room-7" });
    });

    it("ignores an encounter from a character not in the party", () => {
      const { campaign } = makeCampaign(1, undefined, false);
      const stranger = { id: "stranger" } as unknown as ICharacter;

      campaign[RECORD_ENCOUNTER]({ kind: "material", material: "glass" }, stranger, null);

      expect(campaign.codex.size).toBe(0);
    });

    it("allows a party-attributed encounter with no character (characterId undefined)", () => {
      const { campaign } = makeCampaign(1, undefined, false);

      campaign[RECORD_ENCOUNTER]({ kind: "material", material: "food" }, undefined, null);

      const entry = campaign.codex.materials[0]!;
      expect(entry.firstSeen.characterId).toBeUndefined();
      expect(entry.firstSeen.roomId).toBeUndefined();
    });

    it("records mobs encountered on room entry, attributed to the entering party member", () => {
      const { campaign, party } = makeCampaign(1, undefined, false);
      const character = party[0] as unknown as ICharacter;
      const room = new Room("Lair", "a lair", [], {} as ExitsArg);
      const mob = new Mob(campaign, "Goblin", makeStats(), 2, 2, []);
      room.enterRoom(mob);

      campaign[NOTE_ENCOUNTERS](character, room);

      const entry = campaign.codex.mobs[0]!;
      expect(entry.snapshot.name).toBe("Goblin");
      expect(entry.snapshot.stats).toEqual({ health: 10, sanity: 10, energy: 10 });
      expect(entry.firstSeen.characterId).toBe(character.id);
      expect(entry.firstSeen.roomId).toBe(room.id);
    });
  });

  describe("activeCharacter", () => {
    it("starts at the first party member", () => {
      const { campaign, party } = makeCampaign(3);

      expect(campaign.activeCharacter).toBe(party[0]);
    });

    it("throws when there is no character at the active index", () => {
      const { campaign } = makeCampaign(0, undefined, false);

      expect(() => campaign.activeCharacter).toThrow(ProceduralViolation);
    });
  });

  describe("nextPlayer", () => {
    it("advances to the next party member", () => {
      const { campaign, party } = makeCampaign(3);

      campaign.nextPlayer();
      expect(campaign.activeCharacter).toBe(party[1]);

      campaign.nextPlayer();
      expect(campaign.activeCharacter).toBe(party[2]);
    });

    it("wraps back to the first member and ends the round after everyone acts", () => {
      const { campaign, party } = makeCampaign(2);

      campaign.nextPlayer();
      campaign.nextPlayer();

      expect(campaign.activeCharacter).toBe(party[0]);
      expect(campaign.round).toBe(1);
    });

    it("ends the round in a single step for a one-player party", () => {
      const { campaign } = makeCampaign(1);

      campaign.nextPlayer();

      expect(campaign.round).toBe(1);
    });
  });

  describe("endRound", () => {
    it("throws when not every party member has acted", () => {
      const { campaign } = makeCampaign(2);

      expect(() => campaign.endRound()).toThrow(ProceduralViolation);
    });

    it("does not advance the round when it throws", () => {
      const { campaign } = makeCampaign(2);

      expect(() => campaign.endRound()).toThrow();
      expect(campaign.round).toBe(0);
    });

    it("resets activity so a fresh round must be completed again", () => {
      const { campaign } = makeCampaign(1);

      // First nextPlayer completes round 1 and resets activity.
      campaign.nextPlayer();
      expect(campaign.round).toBe(1);

      // A second full cycle is required to reach round 2.
      expect(() => campaign.endRound()).toThrow(ProceduralViolation);
      campaign.nextPlayer();
      expect(campaign.round).toBe(2);
    });

    it("stops incrementing the round once maxRounds is reached", () => {
      const { campaign } = makeCampaign(1, 2);

      campaign.nextPlayer(); // round 1
      campaign.nextPlayer(); // round 2 == maxRounds -> endCampaign

      expect(campaign.round).toBe(2);
    });
  });

  describe("addPlayer", () => {
    it("adds the character to the party", () => {
      const { campaign } = makeCampaign(1);
      const newcomer = makePlayer();

      campaign.addPlayer(newcomer);

      expect(campaign.party).toContain(newcomer);
    });
  });

  describe("leaveCampaign", () => {
    it("removes a non-gm character from the party", () => {
      const { campaign, party, gm } = makeCampaign(3);
      const leaving = party.find((p) => p !== gm)!;

      campaign.leaveCampaign(leaving);

      expect(campaign.party).not.toContain(leaving);
    });

    it("leaves the rest of the party intact", () => {
      const { campaign, party, gm } = makeCampaign(3);
      const leaving = party.find((p) => p !== gm)!;

      campaign.leaveCampaign(leaving);

      expect(campaign.party).toEqual(party.filter((p) => p !== leaving));
    });

    it("throws when the gm tries to leave", () => {
      const { campaign, gm } = makeCampaign(2);

      expect(() => campaign.leaveCampaign(gm)).toThrow(ProceduralViolation);
    });

    it("is a no-op when the character is not in the party", () => {
      const { campaign, party } = makeCampaign(2);
      const outsider = makePlayer();

      campaign.leaveCampaign(outsider);

      expect(campaign.party).toEqual(party);
      expect(campaign.activeCharacter).toBe(party[0]);
    });

    it("preserves the active character when an earlier member leaves", () => {
      const { campaign, party } = makeCampaign(3);
      campaign.nextPlayer();
      campaign.nextPlayer();
      expect(campaign.activeCharacter).toBe(party[2]);

      // party[1] sits before the active index (2) and is not the gm (party[0]).
      campaign.leaveCampaign(party[1]!);

      expect(campaign.activeCharacter).toBe(party[2]);
    });

    it("passes the turn to the next occupant when the active member leaves", () => {
      const { campaign, party } = makeCampaign(3);
      campaign.nextPlayer();
      expect(campaign.activeCharacter).toBe(party[1]);

      campaign.leaveCampaign(party[1]!);

      // party[2] shifts into the slot the departing active member vacated.
      expect(campaign.activeCharacter).toBe(party[2]);
    });

    it("wraps to the first member when the active member was last", () => {
      const { campaign, party } = makeCampaign(3);
      campaign.nextPlayer();
      campaign.nextPlayer();
      expect(campaign.activeCharacter).toBe(party[2]);

      campaign.leaveCampaign(party[2]!);

      expect(campaign.activeCharacter).toBe(party[0]);
    });
  });

  describe("transfer", () => {
    it("hands the gm role to another character", () => {
      const { campaign, party, gm } = makeCampaign(2);
      const successor = party.find((p) => p !== gm)!;

      campaign.transfer(successor);

      expect(campaign.gm).toBe(successor);
    });

    it("lets the former gm leave once the role has been transferred", () => {
      const { campaign, party, gm } = makeCampaign(2);
      const successor = party.find((p) => p !== gm)!;

      campaign.transfer(successor);

      expect(() => campaign.leaveCampaign(gm)).not.toThrow();
      expect(campaign.party).not.toContain(gm);
    });
  });

  describe("lifecycle guards", () => {
    it("begins a fresh campaign and lets it be ended", () => {
      const { campaign } = makeCampaign(1, undefined, false);

      expect(() => campaign.beginCampaign()).not.toThrow();
      expect(() => campaign.endCampaign()).not.toThrow();
    });

    it("throws when the campaign is begun twice", () => {
      const { campaign } = makeCampaign(1);

      expect(() => campaign.beginCampaign()).toThrow(ProceduralViolation);
    });

    it("rejects every action before the campaign has begun", () => {
      const { campaign, party } = makeCampaign(2, undefined, false);

      expect(() => campaign.nextPlayer()).toThrow(ProceduralViolation);
      expect(() => campaign.endRound()).toThrow(ProceduralViolation);
      expect(() => campaign.addPlayer(makePlayer())).toThrow(ProceduralViolation);
      expect(() => campaign.leaveCampaign(party[1]!)).toThrow(ProceduralViolation);
      expect(() => campaign.transfer(party[1]!)).toThrow(ProceduralViolation);
      expect(() => campaign.endCampaign()).toThrow(ProceduralViolation);
    });

    it("rejects every action after the campaign has finished", () => {
      const { campaign, party } = makeCampaign(2);
      campaign.endCampaign();

      expect(() => campaign.nextPlayer()).toThrow(ProceduralViolation);
      expect(() => campaign.endRound()).toThrow(ProceduralViolation);
      expect(() => campaign.addPlayer(makePlayer())).toThrow(ProceduralViolation);
      expect(() => campaign.leaveCampaign(party[1]!)).toThrow(ProceduralViolation);
      expect(() => campaign.transfer(party[1]!)).toThrow(ProceduralViolation);
      expect(() => campaign.endCampaign()).toThrow(ProceduralViolation);
    });
  });

  describe("beginCampaign validation", () => {
    it("throws when the party is empty", () => {
      const campaign = new Campaign("Empty");

      expect(() => campaign.beginCampaign()).toThrow(ProceduralViolation);
    });

    it("throws when the gm is not a member of the party", () => {
      const campaign = new Campaign("Mismatch");
      campaign.party.push(makePlayer());
      campaign.gm = makePlayer(); // a gm who never joined the party

      expect(() => campaign.beginCampaign()).toThrow(ProceduralViolation);
    });

    it("begins when the party is non-empty and contains the gm", () => {
      const campaign = new Campaign("Valid");
      const gm = makePlayer();
      campaign.party.push(gm);
      campaign.gm = gm;

      expect(() => campaign.beginCampaign()).not.toThrow();
    });

    it("throws if a party member has not chosen an archetype", () => {
      const campaign = new Campaign("C");
      const noArchetype = { id: "pc-bare" } as unknown as IPlayerCharacter;
      campaign.party.push(noArchetype);
      campaign.gm = noArchetype;

      expect(() => campaign.beginCampaign()).toThrow(/archetype/);
    });

    it("begins when every party member has an archetype", () => {
      const campaign = new Campaign("C");
      const withArchetype = { id: "pc-ok", archetype: {} } as unknown as IPlayerCharacter;
      campaign.party.push(withArchetype);
      campaign.gm = withArchetype;

      expect(() => campaign.beginCampaign()).not.toThrow();
    });
  });

  describe("gm setter", () => {
    it("assigns the gm before the campaign begins", () => {
      const campaign = new Campaign("Setup");
      const gm = makePlayer();
      campaign.party.push(gm);

      campaign.gm = gm;

      expect(campaign.gm).toBe(gm);
    });

    it("throws when assigning the gm after the campaign has begun", () => {
      const { campaign, party } = makeCampaign(2);
      const other = party[1]!;

      expect(() => {
        campaign.gm = other;
      }).toThrow(ProceduralViolation);
    });
  });

  describe("material pool", () => {
    it("starts empty", () => {
      expect(new Campaign("Materials").materials).toEqual({});
    });

    it("sums deposits by component", () => {
      const campaign = new Campaign("Materials");

      campaign[DEPOSIT_MATERIALS]({ metal: 2 });
      campaign[DEPOSIT_MATERIALS]({ metal: 3, glass: 1 });

      expect(campaign.materials).toEqual({ metal: 5, glass: 1 });
    });

    it("exposes a copy that cannot mutate the pool", () => {
      const campaign = new Campaign("Materials");
      campaign[DEPOSIT_MATERIALS]({ metal: 2 });

      (campaign.materials as Record<string, number>).metal = 99;

      expect(campaign.materials).toEqual({ metal: 2 });
    });

    it("throws when materials is assigned directly", () => {
      const campaign = new Campaign("Materials");

      expect(() => {
        (campaign as unknown as { materials: unknown }).materials = {};
      }).toThrow(ProceduralViolation);
    });
  });

  describe("canAfford / withdrawMaterials", () => {
    function stocked(): Campaign {
      const campaign = new Campaign("Materials");
      campaign[DEPOSIT_MATERIALS]({ metal: 5, glass: 2 });
      return campaign;
    }

    it("affords amounts within the pool", () => {
      expect(stocked().canAfford({ metal: 5, glass: 1 })).toBe(true);
    });

    it("does not afford amounts beyond the pool", () => {
      expect(stocked().canAfford({ metal: 6 })).toBe(false);
      expect(stocked().canAfford({ electronics: 1 })).toBe(false);
    });

    it("subtracts withdrawn materials and removes zeroed components", () => {
      const campaign = stocked();

      campaign.withdrawMaterials({ metal: 5, glass: 1 });

      expect(campaign.materials).toEqual({ glass: 1 });
    });

    it("throws and leaves the pool unchanged when short", () => {
      const campaign = stocked();

      expect(() => campaign.withdrawMaterials({ metal: 6 })).toThrow(
        ProceduralViolation,
      );
      expect(campaign.materials).toEqual({ metal: 5, glass: 2 });
    });
  });

  describe("claimMaterials", () => {
    it("deposits on the first claim of an id", () => {
      const campaign = new Campaign("Materials");

      campaign.claimMaterials("vault-stash", { metal: 3 });

      expect(campaign.materials).toEqual({ metal: 3 });
    });

    it("ignores a repeated claim id", () => {
      const campaign = new Campaign("Materials");

      campaign.claimMaterials("vault-stash", { metal: 3 });
      // A different payload on the repeat proves the call is ignored entirely,
      // not merely deduped to a coincidentally-equal amount.
      campaign.claimMaterials("vault-stash", { metal: 99 });

      expect(campaign.materials).toEqual({ metal: 3 });
    });

    it("deposits again for a different id", () => {
      const campaign = new Campaign("Materials");

      campaign.claimMaterials("a", { metal: 3 });
      campaign.claimMaterials("b", { metal: 2 });

      expect(campaign.materials).toEqual({ metal: 5 });
    });
  });

  describe("known recipes", () => {
    it("starts with no known recipes", () => {
      expect(new Campaign("C").knownRecipes.size).toBe(0);
    });

    it("discoverRecipe makes a recipe known", () => {
      const campaign = new Campaign("C");

      campaign.discoverRecipe(makeRecipe("iron-sword"));

      expect(campaign.knows("iron-sword" as RecipeId)).toBe(true);
    });

    it("keeps the first definition when an id is rediscovered", () => {
      const campaign = new Campaign("C");
      const first = makeRecipe("dup");
      const second: CraftingRecipe = {
        id: "dup" as RecipeId,
        materials: { metal: 9 },
        create: () => ({ name: "OTHER" }) as unknown as IItem,
      };

      campaign.discoverRecipe(first);
      campaign.discoverRecipe(second);

      expect(campaign.knownRecipes.get("dup" as RecipeId)).toBe(first);
    });

    it("seeds known recipes from the constructor", () => {
      const campaign = new Campaign("C", 100, [makeRecipe("seeded")]);

      expect(campaign.knows("seeded" as RecipeId)).toBe(true);
    });
  });

  describe("encounters", () => {
    const formation: Formation = {
      id: "goblins",
      weight: 1,
      build: (c) => [new Mob(c, "Goblin", makeStats(), 2, 2, [])],
    };

    it("spawns a formation via maybeSpawn when the roll passes", () => {
      const campaign = new Campaign("C", 100, [], { rng: () => 0, baseEncounterChance: 50 });
      campaign.addFormation(formation);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg, [], 1);

      const spawned = campaign.maybeSpawn(cave);

      expect(spawned).toHaveLength(1);
      expect(cave.occupants).toContain(spawned[0]);
    });

    it("rejects a formation whose mobs drop keys", () => {
      const campaign = new Campaign("C", 100, [], { rng: () => 0, baseEncounterChance: 50 });
      const bad: Formation = {
        id: "thief",
        weight: 1,
        build: (c) => [
          new Mob(c, "Thief", makeStats(), 2, 2, [
            createKey({ name: "K", keyCode: "k", consumeOnUse: false }),
          ]),
        ],
      };
      expect(() => campaign.addFormation(bad)).toThrow();
    });
  });

  describe("archetype catalog", () => {
    function makeArchetype(id: string): Archetype {
      return { id: id as ArchetypeId, name: id };
    }

    it("registers an archetype and exposes it via the read-only view", () => {
      const campaign = new Campaign("C");
      const brawler = makeArchetype("brawler");

      campaign.registerArchetype(brawler);

      expect(campaign.archetypes.get(brawler.id)).toBe(brawler);
    });

    it("is idempotent by id (first definition wins)", () => {
      const campaign = new Campaign("C");
      const first = makeArchetype("brawler");
      const second: Archetype = { id: "brawler" as ArchetypeId, name: "Other" };

      campaign.registerArchetype(first);
      campaign.registerArchetype(second);

      expect(campaign.archetypes.get(first.id)).toBe(first);
      expect(campaign.archetypes.size).toBe(1);
    });

    it("reports started=false before begin and true after", () => {
      const campaign = new Campaign("C");
      expect(campaign.started).toBe(false);

      const pc = { id: "pc-arch", archetype: {} } as unknown as IPlayerCharacter;
      campaign.party.push(pc);
      campaign.gm = pc;
      campaign.beginCampaign();

      expect(campaign.started).toBe(true);
    });
  });

  describe("cue stream", () => {
    it("delivers an emitted cue to subscribers and stops after offCue", () => {
      const campaign = new Campaign("C");
      const seen: PresentationCue[] = [];
      const handler = (cue: PresentationCue) => seen.push(cue);

      campaign.onCue(handler);
      campaign[EMIT_CUE]({ kind: "encounter", mob: { id: "m1", name: "Imp" }, room: { id: "r1", name: "Cell" }, sound: "screech.ogg" });
      campaign.offCue(handler);
      campaign[EMIT_CUE]({ kind: "encounter", mob: { id: "m2", name: "Rat" }, room: { id: "r1", name: "Cell" } });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "encounter", sound: "screech.ogg" });
    });

    it("fills an action cue's missing sound from the campaign default map", () => {
      const campaign = new Campaign("C", 100, [], { actionSounds: { move: "marching.ogg" } });
      const seen: PresentationCue[] = [];
      campaign.onCue((cue) => seen.push(cue));

      campaign[EMIT_CUE]({ kind: "action", action: "move", actor: { id: "p1", name: "Hero" } });
      campaign[EMIT_CUE]({ kind: "action", action: "move", actor: { id: "p1", name: "Hero" }, sound: "tiptoe.ogg" });

      expect(seen[0]).toMatchObject({ action: "move", sound: "marching.ogg" }); // default applied
      expect(seen[1]).toMatchObject({ action: "move", sound: "tiptoe.ogg" });   // explicit wins
    });

    it("isolates a throwing subscriber so others still receive the cue", () => {
      const campaign = new Campaign("C");
      const seen: PresentationCue[] = [];
      campaign.onCue(() => { throw new Error("bad handler"); });
      campaign.onCue((cue) => seen.push(cue));

      expect(() =>
        campaign[EMIT_CUE]({ kind: "encounter", mob: { id: "m", name: "M" }, room: { id: "r", name: "R" } }),
      ).not.toThrow();
      expect(seen).toHaveLength(1);
    });
  });
});
