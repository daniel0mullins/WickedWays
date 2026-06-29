export interface Segment {
  text: string;
  noun?: string;
}

/**
 * Split `line` into plain-text and noun segments.
 *
 * A segment with `noun` set is a clickable token whose click should fill
 * `examine <noun>`. Matches each noun phrase case-insensitively on word-ish
 * boundaries, longest phrase first (so "Iron Fire-Poker" wins over "iron"),
 * non-overlapping, preserving the original surface text in `text`.
 *
 * Nouns shorter than 3 characters are ignored (too noisy).
 */
export function linkNouns(line: string, nouns: string[]): Segment[] {
  // Filter out very short/noisy nouns and de-duplicate (case-insensitive).
  const seen = new Set<string>();
  const filtered = nouns.filter((n) => {
    if (n.length < 3) return false;
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (filtered.length === 0) return [{ text: line }];

  // Sort longest first so multi-word phrases beat single-word prefixes.
  const sorted = [...filtered].sort((a, b) => b.length - a.length);

  const segments: Segment[] = [];
  let pos = 0;

  while (pos < line.length) {
    let matched = false;

    for (const noun of sorted) {
      const idx = line.toLowerCase().indexOf(noun.toLowerCase(), pos);
      if (idx !== pos) continue;

      // Word-boundary check: preceding char must be start-of-string or non-alphanumeric.
      const beforeChar: string = idx === 0 ? "" : (line[idx - 1] ?? "");
      if (beforeChar !== "" && /\w/.test(beforeChar)) continue;

      // Following char must be end-of-string or non-alphanumeric.
      const afterIdx = idx + noun.length;
      const afterChar: string = afterIdx < line.length ? (line[afterIdx] ?? "") : "";
      if (afterChar !== "" && /\w/.test(afterChar)) continue;

      // Emit the noun segment using the original surface text.
      const surface = line.slice(idx, idx + noun.length);
      segments.push({ text: surface, noun: surface });
      pos = afterIdx;
      matched = true;
      break;
    }

    if (!matched) {
      // Accumulate plain text until the next possible match position.
      const nextMatch = findNextMatch(line, sorted, pos);
      const end = nextMatch === -1 ? line.length : nextMatch;
      const plain = line.slice(pos, end);
      if (plain.length > 0) {
        // Merge into last plain segment if possible.
        const last = segments[segments.length - 1];
        if (last !== undefined && last.noun === undefined) {
          last.text += plain;
        } else {
          segments.push({ text: plain });
        }
      }
      pos = end;
    }
  }

  return segments.length > 0 ? segments : [{ text: line }];
}

/** Returns the index of the nearest word-boundary match among all nouns, or -1. */
function findNextMatch(line: string, sorted: string[], from: number): number {
  const lower = line.toLowerCase();
  let nearest = -1;

  for (const noun of sorted) {
    const nLower = noun.toLowerCase();
    let searchFrom = from;
    while (searchFrom < line.length) {
      const idx = lower.indexOf(nLower, searchFrom);
      if (idx === -1) break;

      const beforeChar: string = idx === 0 ? "" : (line[idx - 1] ?? "");
      const afterIdx = idx + noun.length;
      const afterChar: string = afterIdx < line.length ? (line[afterIdx] ?? "") : "";

      const boundaryBefore = beforeChar === "" || !/\w/.test(beforeChar);
      const boundaryAfter = afterChar === "" || !/\w/.test(afterChar);

      if (boundaryBefore && boundaryAfter) {
        if (nearest === -1 || idx < nearest) nearest = idx;
        break;
      }
      searchFrom = idx + 1;
    }
  }

  return nearest;
}
