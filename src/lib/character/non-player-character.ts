import { ICampaign } from "../campaign";
import { Character, ICharacter } from "./character";
import type { AfflictionConfig } from "./afflictions";
import type { Presentation } from "../presentation";
import { Stats } from "./stats";
import { ProceduralViolation } from "../util";
import type { CharacterSnapshot } from "../serialization/types";

/** Fields shared by every dialogue block: its responses and an optional gate. */
type DialogueBase = {
  response: string[];
  precondition?: (c: Character) => boolean;
};

/**
 * A unit of NPC dialogue. A `"fuzzy"` block triggers when its trigger tokens are
 * all present in the prompt; an `"exact"` block triggers on a full string match.
 */
export type IDialogue =
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

/** Constructor options for a {@link NonPlayerCharacter}. */
export interface NonPlayerCharacterOptions {
  /** The campaign the NPC belongs to. */
  campaign: ICampaign;
  /** Display name. */
  name: string;
  /** Initial {@link Stats}. */
  stats: Stats;
  /** Line returned when talked to without a prompt. */
  initialDialogue: string;
  /** Blocks whose triggers drive prompted responses. */
  dialogueBlocks: IDialogue[];
  /** Injected randomness for deterministic tests. */
  rng?: () => number;
  /** Overrides the default affliction thresholds/roll config. */
  afflictionConfig?: AfflictionConfig;
  /** Optional presentation metadata (image/sound) for the Play Surface. */
  presentation?: Presentation;
  /**
   * Registry key whose {@link NpcBehavior} this NPC's dialogue re-binds from on
   * deserialization. Required for the NPC to survive serialization (its dialogue
   * preconditions are functions). Authored NPCs always carry one.
   */
  behaviorKey?: string;
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
  #behaviorKey?: string;

  // Triggers are normalized once at construction so matching a prompt does not
  // re-lowercase every trigger on each call. `matches` is closed over the
  // pre-normalized trigger; the prompt is normalized once per call instead.
  #matchers: DialogueMatcher[];

  get dialogueBlocks() {
    return this.#dialogueBlocks;
  }

  /**
   * Registry key whose dialogue behavior this NPC re-binds from (set once at
   * construction, never mutated). Read-only; the dialogue matcher resolves the
   * NpcScript against it — mirrors the Rust snapshot's `npc_behavior_key`.
   */
  get behaviorKey(): string | undefined {
    return this.#behaviorKey;
  }

  protected override serializeKind(): "npc" {
    return "npc";
  }

  protected override serializeExtra(snap: CharacterSnapshot): void {
    if (this.#behaviorKey === undefined) {
      throw new ProceduralViolation(
        `NPC ${this.id} cannot be serialized: no behaviorKey (its dialogue cannot re-bind).`,
      );
    }
    snap.npcBehaviorKey = this.#behaviorKey;
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

  /** See {@link NonPlayerCharacterOptions} for parameter details. */
  constructor(opts: NonPlayerCharacterOptions) {
    super({
      campaign: opts.campaign,
      name: opts.name,
      stats: opts.stats,
      inventorySlots: 5,
      actionsPerRound: 3,
      rng: opts.rng,
      afflictionConfig: opts.afflictionConfig,
      presentation: opts.presentation,
    });
    this.initialDialogue = opts.initialDialogue;
    this.#dialogueBlocks = opts.dialogueBlocks;
    this.#behaviorKey = opts.behaviorKey;
    this.#matchers = opts.dialogueBlocks.map((block) =>
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
