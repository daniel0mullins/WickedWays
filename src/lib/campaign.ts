import { Brand } from "./brand";
import { IPlayerCharacter } from "./character/player-character";
import { generateId, ProceduralViolation } from "./util";

export type CampaignId = Brand<string, "CampaignId">;

export interface ICampaign {
  // ### Properties
  id: CampaignId;
  party: IPlayerCharacter[];
  title: string;

  readonly maxRounds: number;

  get activeCharacter(): IPlayerCharacter;
  get gm(): IPlayerCharacter;
  get round(): number;

  // ### Methods
  beginCampaign: () => void;
  endCampaign: () => void;
  endRound: () => void;
  joinCampaign: (c: IPlayerCharacter) => void;
  leaveCampaign: (c: IPlayerCharacter) => void;
  nextPlayer: () => void;
  transfer: (c: IPlayerCharacter) => void;
}

export class Campaign implements ICampaign {
  id: CampaignId;
  title: string;
  party: IPlayerCharacter[];
  #round: number;
  #gm: IPlayerCharacter;
  readonly maxRounds: number;

  #started = false;
  #finished = false;
  #activeCharacterIndex: number = 0;
  #actedThisRound: WeakMap<IPlayerCharacter, boolean>;

  get round() {
    return this.#round;
  }

  get gm() {
    return this.#gm;
  }

  get activeCharacter() {
    const activeCharacter = this.party[this.#activeCharacterIndex];
    if (activeCharacter) {
      return activeCharacter;
    } else {
      throw new ProceduralViolation("Unable to resolve active character");
    }
  }

  #resetActivity() {
    for (const character of this.party) {
      this.#actedThisRound.set(character, false);
    }
  }

  #assertRunning() {
    if (!this.#started) {
      throw new ProceduralViolation("Campaign has not begun");
    }
    if (this.#finished) {
      throw new ProceduralViolation("Campaign has already finished");
    }
  }

  constructor(
    title: string,
    players: IPlayerCharacter[],
    gm: IPlayerCharacter,
    maxRounds: number = 100,
  ) {
    this.id = generateId<CampaignId>();
    this.title = title;
    this.party = players;
    this.#round = 0;
    this.#gm = gm;
    this.maxRounds = maxRounds;

    this.#actedThisRound = new WeakMap<IPlayerCharacter, boolean>();
    this.#resetActivity();

    this.#activeCharacterIndex = 0;
  }

  beginCampaign() {
    if (this.#started) {
      throw new ProceduralViolation("Campaign has already begun");
    }
    this.#started = true;
  }

  endCampaign() {
    this.#assertRunning();
    this.#finished = true;
  }

  endRound() {
    this.#assertRunning();
    const allPartyActed = this.party.every((c) => this.#actedThisRound.get(c));
    if (allPartyActed) {
      this.#round = this.#round + 1;
      if (this.#round >= this.maxRounds) {
        this.endCampaign();
      }
      this.#resetActivity();
    } else {
      throw new ProceduralViolation(
        "Attempted to end round before all characters have acted",
      );
    }
  }

  joinCampaign(c: IPlayerCharacter) {
    this.#assertRunning();
    this.party.push(c);
  }

  leaveCampaign(c: IPlayerCharacter) {
    this.#assertRunning();
    if (this.gm === c) {
      throw new ProceduralViolation(
        "GM cannot leave the campaign, transfer the campaign first",
      );
    }

    const index = this.party.indexOf(c);
    this.party = this.party.filter((pc) => pc !== c);

    if (index !== -1) {
      // Keep the active index pointing at the same turn position: shift it down
      // when an earlier member leaves, and wrap to the start if it now dangles
      // past the end of the (shrunk) party.
      if (index < this.#activeCharacterIndex) {
        this.#activeCharacterIndex -= 1;
      } else if (this.#activeCharacterIndex >= this.party.length) {
        this.#activeCharacterIndex = 0;
      }
    }
  }

  nextPlayer() {
    this.#assertRunning();
    this.#actedThisRound.set(this.activeCharacter, true);
    const nextIndex = this.#activeCharacterIndex + 1;
    if (nextIndex === this.party.length) {
      this.#activeCharacterIndex = 0;
      this.endRound();
    } else {
      this.#activeCharacterIndex = nextIndex;
    }
  }

  transfer(c: IPlayerCharacter) {
    this.#assertRunning();
    this.#gm = c;
  }
}
