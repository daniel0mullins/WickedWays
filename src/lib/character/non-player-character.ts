import { ICampaign } from "../campaign";
import { Character, ICharacter } from "./character";
import { Stats } from "./stats";

type DialogueBase = {
  response: string[];
  precondition?: (c: Character) => boolean;
};

type IDialogue =
  | (DialogueBase & { type: "fuzzy"; trigger: Set<string> })
  | (DialogueBase & { type: "exact"; trigger: string });

export interface INonPlayerCharacter extends ICharacter {
  dialogue: (prompt?: string) => string[];
  readonly dialogueBlocks: IDialogue[];
  initialDialogue: string;
}

export class NonPlayerCharacter
  extends Character
  implements INonPlayerCharacter
{
  initialDialogue: string;
  #dialogueBlocks: IDialogue[];

  get dialogueBlocks() {
    return this.#dialogueBlocks;
  }

  #generateResponse(prompt: string): string[] {
    const responses: string[] = [];

    for (const block of this.dialogueBlocks) {
      if (block.type === "exact") {
        if (block.trigger === prompt) {
          if (block.precondition && block.precondition(this)) {
            responses.push(...block.response);
          } else if (!block.precondition) {
            responses.push(...block.response);
          }
        }
      } else {
        const promptTokens = prompt
          .split(/\s+/)
          .reduce((accumulator, chunk) => {
            const trimmedChunk = chunk.toLowerCase().trim();
            if (trimmedChunk.length > 0) {
              accumulator.add(trimmedChunk);
            }
            return accumulator;
          }, new Set<string>());
        if (block.trigger.isSubsetOf(promptTokens)) {
          // If every trigger word is in the prompt
          if (block.precondition && block.precondition(this)) {
            responses.push(...block.response);
          } else if (!block.precondition) {
            responses.push(...block.response);
          }
        }
      }
    }

    return responses;
  }

  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    initialDialogue: string,
    dialogueBlocks: IDialogue[],
  ) {
    super(campaign, name, stats);
    this.initialDialogue = initialDialogue;
    this.#dialogueBlocks = dialogueBlocks;
  }

  dialogue(prompt?: string) {
    if (!prompt) {
      return [this.initialDialogue];
    } else {
      return this.#generateResponse(prompt);
    }
  }
}
