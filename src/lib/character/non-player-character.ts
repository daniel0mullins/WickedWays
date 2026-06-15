import { ICampaign } from "../campaign";
import { Character, CharacterOptions, ICharacter } from "./character";
import { Stats } from "./stats";

/** Fields shared by every dialogue block: its responses and an optional gate. */
type DialogueBase = {
  response: string[];
  precondition?: (c: Character) => boolean;
};

/**
 * A unit of NPC dialogue. A `"fuzzy"` block triggers when its trigger tokens are
 * all present in the prompt; an `"exact"` block triggers on a full string match.
 */
type IDialogue =
  | (DialogueBase & { type: "fuzzy"; trigger: Set<string> })
  | (DialogueBase & { type: "exact"; trigger: string });

/** A dialogue block paired with its precompiled prompt-matching predicate. */
type DialogueMatcher = {
  block: IDialogue;
  matches: (normalizedPrompt: string, promptTokens: Set<string>) => boolean;
};

/**
 * A character the player can talk to. Responds to prompts by matching them
 * against its dialogue blocks, falling back to an initial greeting.
 */
export interface INonPlayerCharacter extends ICharacter {
  /** Returns responses for `prompt`, or the initial line when no prompt is given. */
  dialogue: (prompt?: string) => string[];
  /** The dialogue blocks driving this NPC's responses. */
  readonly dialogueBlocks: IDialogue[];
  /** Line returned when {@link INonPlayerCharacter.dialogue} is called with no prompt. */
  initialDialogue: string;
}

/**
 * Default {@link INonPlayerCharacter} implementation.
 *
 * Dialogue triggers are normalized to lowercase once at construction so that
 * matching a prompt does not re-process every trigger on each call; the prompt
 * itself is normalized once per {@link NonPlayerCharacter.dialogue} call.
 */
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

  /**
   * @param campaign - The campaign the NPC belongs to.
   * @param name - Display name.
   * @param stats - Initial {@link Stats}.
   * @param initialDialogue - Line returned when talked to without a prompt.
   * @param dialogueBlocks - Blocks whose triggers drive prompted responses.
   * @param options - Optional character options (rng, afflictionConfig, presentation).
   */
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    initialDialogue: string,
    dialogueBlocks: IDialogue[],
    options: CharacterOptions = {},
  ) {
    super(campaign, name, stats, 5, 3, options);
    this.initialDialogue = initialDialogue;
    this.#dialogueBlocks = dialogueBlocks;
    this.#matchers = dialogueBlocks.map((block) =>
      this.#normalizeMatcher(block),
    );
  }

  /**
   * Produces the NPC's spoken response.
   *
   * @param prompt - What the player says. When omitted, the NPC returns its
   *   {@link NonPlayerCharacter.initialDialogue}.
   * @returns The concatenated responses of every matching, precondition-satisfied
   *   dialogue block (empty if none match).
   */
  dialogue(prompt?: string) {
    if (!prompt) {
      return [this.initialDialogue];
    } else {
      return this.#generateResponse(prompt);
    }
  }
}
