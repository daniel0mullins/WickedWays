import { Brand } from "./brand";
import { IPlayerCharacter } from "./character/player-character";
import { generateId, ProceduralViolation } from "./util";

export type CampaignId = Brand<string, "CampaignId">;

export interface ICampaign {
  // ### Properties
  id: CampaignId;
  title: string;
  party: IPlayerCharacter[];
  readonly maxRounds: number;
  get round(): number;
  get gm(): IPlayerCharacter;
  get activeCharacter(): IPlayerCharacter;

  // ### Methods
  endRound: () => void;
  transfer: (c: IPlayerCharacter) => void;
  beginCampaign: () => void;
  endCampaign: () => void;
  joinCampaign: (c: IPlayerCharacter) => void;
  leaveCampaign: (c: IPlayerCharacter) => void;
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
  #activeCharacter: IPlayerCharacter;
  #actedThisRound: WeakMap<IPlayerCharacter, boolean>;

  get round() {
    return this.#round;
  }

  get gm() {
    return this.#gm;
  }

  get activeCharacter() {
    return this.#activeCharacter;
  }

  #resetActivity() {
    for (const character of this.party) {
      this.#actedThisRound.set(character, false);
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

    const activeCharacter = this.party[0];
    if (activeCharacter) {
      this.#activeCharacter = activeCharacter;
    } else {
      throw new ProceduralViolation(
        "Unable to set active character in campaign set up",
      );
    }
  }

  endRound() {
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

  beginCampaign() {
    this.#started = true;
  }

  endCampaign() {
    this.#finished = true;
  }

  joinCampaign(c: IPlayerCharacter) {
    this.party.push(c);
  }

  leaveCampaign(c: IPlayerCharacter) {
    if (this.gm === c) {
      throw new ProceduralViolation(
        "GM cannot leave the campaign, transfer the campaign first",
      );
    } else {
      this.party = this.party.filter((pc) => pc !== c);
    }
  }

  transfer(c: IPlayerCharacter) {
    this.#gm = c;
  }
}
