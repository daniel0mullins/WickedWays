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

type DialogueMatcher = {
  block: IDialogue;
  matches: (normalizedPrompt: string, promptTokens: Set<string>) => boolean;
};

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

  // Triggers are normalized once at construction so matching a prompt does not
  // re-lowercase every trigger on each call. `matches` is closed over the
  // pre-normalized trigger; the prompt is normalized once per call instead.
  #matchers: DialogueMatcher[];

  get dialogueBlocks() {
    return this.#dialogueBlocks;
  }

  #normalizeMatcher(block: IDialogue): DialogueMatcher {
    if (block.type === "exact") {
      const trigger = block.trigger.toLowerCase();
      return { block, matches: (normalizedPrompt) => normalizedPrompt === trigger };
    }

    const triggerTokens = block.trigger.values().reduce((accumulator, word) => {
      accumulator.add(word.toLowerCase());
      return accumulator;
    }, new Set<string>());
    return {
      block,
      matches: (_normalizedPrompt, promptTokens) =>
        triggerTokens.isSubsetOf(promptTokens),
    };
  }

  #preconditionMet(block: IDialogue): boolean {
    return !block.precondition || block.precondition(this);
  }

  #tokenize(normalizedPrompt: string): Set<string> {
    return normalizedPrompt.split(/\s+/).reduce((accumulator, chunk) => {
      const trimmedChunk = chunk.trim();
      if (trimmedChunk.length > 0) {
        accumulator.add(trimmedChunk);
      }
      return accumulator;
    }, new Set<string>());
  }

  #generateResponse(prompt: string): string[] {
    const normalizedPrompt = prompt.toLowerCase();
    const promptTokens = this.#tokenize(normalizedPrompt);

    const responses: string[] = [];
    for (const { block, matches } of this.#matchers) {
      if (matches(normalizedPrompt, promptTokens) && this.#preconditionMet(block)) {
        responses.push(...block.response);
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
    this.#matchers = dialogueBlocks.map((block) =>
      this.#normalizeMatcher(block),
    );
  }

  dialogue(prompt?: string) {
    if (!prompt) {
      return [this.initialDialogue];
    } else {
      return this.#generateResponse(prompt);
    }
  }
}
