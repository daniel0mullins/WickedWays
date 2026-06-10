import { describe, expect, it } from "vitest";

import { Campaign } from "./campaign";
import type { IPlayerCharacter } from "./character/player-character";
import { ProceduralViolation } from "./util";
import { DEPOSIT_MATERIALS } from "./inventory";

// `Campaign` only stores players and compares them by identity, so distinct
// stub objects cast to `IPlayerCharacter` are enough (WeakMap needs objects).
let counter = 0;
function makePlayer(): IPlayerCharacter {
  return { id: `pc-${++counter}` } as unknown as IPlayerCharacter;
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
});
