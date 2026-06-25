import { Directions, type Direction } from "wickedways/lib/room";
import type { Intent } from "../core/intent.js";
import type { ViewModel, ScopeEntity } from "../core/viewmodel.js";

export type ParseResult =
  | { kind: "intent"; intent: Intent }
  | { kind: "query"; query: "look" | "inventory" | "exits" | "help" }
  | { kind: "examine"; target: ScopeEntity }
  | { kind: "meta"; meta: "save" | "restore" | "undo" }
  | { kind: "ambiguous"; candidates: ScopeEntity[] }
  | { kind: "error"; message: string };

const DIRECTIONS: Record<string, Direction> = {
  north: Directions.North, n: Directions.North, south: Directions.South, s: Directions.South,
  east: Directions.East, e: Directions.East, west: Directions.West, w: Directions.West,
  northeast: Directions.Northeast, ne: Directions.Northeast, northwest: Directions.Northwest, nw: Directions.Northwest,
  southeast: Directions.Southeast, se: Directions.Southeast, southwest: Directions.Southwest, sw: Directions.Southwest,
};

// Leading filler words stripped from a command's noun phrase: articles plus the
// common prepositions that show up in phrasings like "look at", "give to", "open with".
const STOP_WORDS = new Set(["the", "a", "an", "at", "to", "with", "on"]);

// Verb → a function needing a resolved noun, returning an Intent or an error.
type NounVerb = (target: ScopeEntity) => Intent | { error: string };

const NOUN_VERBS: Record<string, NounVerb> = {
  take: (t) => t.kind === "loot" ? { error: "Open it first, then take what's inside." } : { kind: "take", targetId: t.id },
  get: (t) => t.kind === "loot" ? { error: "Open it first, then take what's inside." } : { kind: "take", targetId: t.id },
  drop: (t) => ({ kind: "drop", targetId: t.id }),
  attack: (t) => ({ kind: "attack", targetId: t.id }),
  kill: (t) => ({ kind: "attack", targetId: t.id }),
  hit: (t) => ({ kind: "attack", targetId: t.id }),
  equip: (t) => ({ kind: "equip", targetId: t.id }),
  wear: (t) => ({ kind: "equip", targetId: t.id }),
  wield: (t) => ({ kind: "equip", targetId: t.id }),
  light: (t) => ({ kind: "equip", targetId: t.id }),
  unequip: (t) => ({ kind: "unequip", targetId: t.id }),
  remove: (t) => ({ kind: "unequip", targetId: t.id }),
  extinguish: (t) => ({ kind: "unequip", targetId: t.id }),
  use: (t) => ({ kind: "use", targetId: t.id }),
  open: (t) => t.kind === "loot" ? { kind: "open", targetId: t.id } : { error: "You can't open that." },
};

export function parse(input: string, vm: ViewModel): ParseResult {
  const tokens = input.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { kind: "error", message: "Say something." };

  const verb = tokens[0]!;

  // Bare direction or "go <dir>".
  const bareDir = DIRECTIONS[verb];
  if (bareDir !== undefined) return { kind: "intent", intent: { kind: "move", dir: bareDir } };
  if (verb === "go" || verb === "walk") {
    const d = tokens[1] !== undefined ? DIRECTIONS[tokens[1]] : undefined;
    return d !== undefined ? { kind: "intent", intent: { kind: "move", dir: d } } : { kind: "error", message: "Go where?" };
  }

  // Meta verbs.
  if (verb === "save") return { kind: "meta", meta: "save" };
  if (verb === "restore" || verb === "load") return { kind: "meta", meta: "restore" };
  if (verb === "undo") return { kind: "meta", meta: "undo" };

  // Zero-noun queries.
  if (verb === "look" || verb === "l") return { kind: "query", query: "look" };
  if (verb === "inventory" || verb === "i" || verb === "inv") return { kind: "query", query: "inventory" };
  if (verb === "exits") return { kind: "query", query: "exits" };
  if (verb === "help" || verb === "?") return { kind: "query", query: "help" };
  if (verb === "wait" || verb === "z") return { kind: "intent", intent: { kind: "wait" } };

  const nounPhrase = tokens.slice(1).filter((t) => !STOP_WORDS.has(t)).join(" ");

  // examine is special: resolve then return an examine result (no engine call).
  if (verb === "examine" || verb === "x" || verb === "look-at") {
    if (!nounPhrase) return { kind: "query", query: "look" };
    return resolveThen(nounPhrase, vm, (t) => ({ kind: "examine", target: t }));
  }

  const handler = NOUN_VERBS[verb];
  if (handler === undefined) return { kind: "error", message: `I don't know how to "${verb}".` };
  if (!nounPhrase) return { kind: "error", message: `${verb} what?` };

  return resolveThen(nounPhrase, vm, (t) => {
    const out = handler(t);
    return "error" in out ? { kind: "error", message: out.error } : { kind: "intent", intent: out };
  });
}

function resolveThen(nounPhrase: string, vm: ViewModel, build: (t: ScopeEntity) => ParseResult): ParseResult {
  const matches = resolve(nounPhrase, vm.scope);
  if (matches.length === 0) return { kind: "error", message: "You don't see that here." };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  return build(matches[0]!);
}

// Match the phrase against each entity's name + aliases (exact first, then substring/token).
function resolve(phrase: string, scope: ScopeEntity[]): ScopeEntity[] {
  const exact = scope.filter((e) => e.aliases.some((a) => a === phrase) || e.name.toLowerCase() === phrase);
  if (exact.length > 0) return dedupe(exact);
  const partial = scope.filter((e) =>
    e.aliases.some((a) => a.includes(phrase) || phrase.includes(a)) || e.name.toLowerCase().includes(phrase),
  );
  return dedupe(partial);
}

function dedupe(entities: ScopeEntity[]): ScopeEntity[] {
  const seen = new Set<string>();
  return entities.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
