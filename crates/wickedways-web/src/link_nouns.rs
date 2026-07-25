//! Clickable-noun segmentation (Phase 2c, sub-project D).
//!
//! Ports `play-surface/src/crt/link-nouns.ts`: split a line of prose into plain-text and **noun**
//! segments. A segment with `noun` set is a clickable token — the CRT surface renders it as a `.noun`
//! span whose click fills the prompt with `examine <noun>`. Matches each noun phrase
//! case-insensitively on word boundaries, longest phrase first (so "Iron Fire-Poker" beats "iron"),
//! non-overlapping, preserving the original surface casing in `text`. Nouns shorter than 3 characters
//! are ignored (too noisy). Pure and host-tested; the CRT wiring lives in [`crate::crt`].

use std::collections::HashSet;

/// One piece of a segmented line: `text` is the surface substring; `noun`, when set, marks it as a
/// clickable noun (its value is the surface text to examine).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub noun: Option<String>,
}

/// A "word" character for the boundary check — ASCII alphanumeric or underscore (JS `\w`).
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Find `needle` in `hay` (both already lowercased), returning the first char-index or `None`.
fn find_sub(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Split `line` into plain / noun [`Segment`]s against the clickable `nouns`. See the module docs.
pub fn link_nouns(line: &str, nouns: &[String]) -> Vec<Segment> {
    let chars: Vec<char> = line.chars().collect();

    // Filter out short/noisy nouns and de-duplicate (case-insensitive), keeping first-seen order.
    let mut seen = HashSet::new();
    let mut filtered: Vec<Vec<char>> = Vec::new();
    for n in nouns {
        let lower = n.to_ascii_lowercase();
        if lower.chars().count() < 3 {
            continue;
        }
        if seen.insert(lower.clone()) {
            filtered.push(lower.chars().collect());
        }
    }
    if filtered.is_empty() {
        return vec![Segment {
            text: line.to_string(),
            noun: None,
        }];
    }
    // Longest first so multi-word phrases beat single-word prefixes.
    filtered.sort_by_key(|nl| std::cmp::Reverse(nl.len()));

    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let n = chars.len();

    // Does the lowercased noun `nl` match at exactly `pos`, on word boundaries both sides?
    let matches_at = |nl: &[char], pos: usize| -> bool {
        if pos + nl.len() > n || &lower[pos..pos + nl.len()] != nl {
            return false;
        }
        let before_ok = pos == 0 || !is_word(chars[pos - 1]);
        let after = pos + nl.len();
        let after_ok = after >= n || !is_word(chars[after]);
        before_ok && after_ok
    };

    // The nearest boundary-match position at or after `from`, across all nouns.
    let next_match = |from: usize| -> Option<usize> {
        let mut nearest: Option<usize> = None;
        for nl in &filtered {
            let mut search = from;
            while let Some(idx) = find_sub(&lower, nl, search) {
                if matches_at(nl, idx) {
                    nearest = Some(nearest.map_or(idx, |x| x.min(idx)));
                    break;
                }
                search = idx + 1;
            }
        }
        nearest
    };

    let mut segments: Vec<Segment> = Vec::new();
    let mut pos = 0;
    while pos < n {
        // Try to emit a noun at `pos` (longest first).
        if let Some(nl) = filtered.iter().find(|nl| matches_at(nl, pos)) {
            let surface: String = chars[pos..pos + nl.len()].iter().collect();
            segments.push(Segment {
                text: surface.clone(),
                noun: Some(surface),
            });
            pos += nl.len();
            continue;
        }
        // Otherwise accumulate plain text up to the next match (or end), merging into the last plain.
        let end = match next_match(pos) {
            Some(e) if e > pos => e,
            _ => n,
        };
        let plain: String = chars[pos..end].iter().collect();
        if !plain.is_empty() {
            match segments.last_mut() {
                Some(last) if last.noun.is_none() => last.text.push_str(&plain),
                _ => segments.push(Segment {
                    text: plain,
                    noun: None,
                }),
            }
        }
        pos = end;
    }

    if segments.is_empty() {
        vec![Segment {
            text: line.to_string(),
            noun: None,
        }]
    } else {
        segments
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nouns(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// Reconstruct the original line from segments — must always be exact.
    fn join(segs: &[Segment]) -> String {
        segs.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn splits_a_line_with_one_known_noun_into_plain_noun_plain() {
        let segs = link_nouns("You see a Lantern on the shelf.", &nouns(&["Lantern"]));
        assert_eq!(segs.len(), 3);
        assert_eq!(
            segs[0],
            Segment {
                text: "You see a ".into(),
                noun: None
            }
        );
        assert_eq!(
            segs[1],
            Segment {
                text: "Lantern".into(),
                noun: Some("Lantern".into())
            }
        );
        assert_eq!(
            segs[2],
            Segment {
                text: " on the shelf.".into(),
                noun: None
            }
        );
    }

    #[test]
    fn concatenating_all_text_reproduces_the_original_line() {
        let line = "An Iron Fire-Poker rests by the hearth.";
        let segs = link_nouns(line, &nouns(&["Iron Fire-Poker", "iron", "hearth"]));
        assert_eq!(join(&segs), line);
    }

    #[test]
    fn longest_first_wins() {
        let segs = link_nouns(
            "An Iron Fire-Poker rests nearby.",
            &nouns(&["iron", "Iron Fire-Poker"]),
        );
        let noun_segs: Vec<_> = segs.iter().filter(|s| s.noun.is_some()).collect();
        assert_eq!(noun_segs.len(), 1);
        assert_eq!(noun_segs[0].noun.as_deref(), Some("Iron Fire-Poker"));
    }

    #[test]
    fn does_not_match_iron_inside_environment() {
        let segs = link_nouns("The environment is cold.", &nouns(&["iron"]));
        assert!(segs.iter().all(|s| s.noun.is_none()));
    }

    #[test]
    fn short_nouns_and_mid_word_are_not_matched() {
        // "on" is < 3 chars → filtered out entirely (so no match inside "Iron").
        let segs = link_nouns("Iron bars block the way.", &nouns(&["on"]));
        assert!(segs.iter().all(|s| s.noun.is_none()));
        // "iron" must not match inside "ironic".
        let segs = link_nouns("That would be ironic.", &nouns(&["iron"]));
        assert!(segs.iter().all(|s| s.noun.is_none()));
    }

    #[test]
    fn a_line_with_no_known_noun_returns_a_single_plain_segment() {
        let segs = link_nouns("The room is dark and quiet.", &nouns(&["Lantern"]));
        assert_eq!(
            segs,
            vec![Segment {
                text: "The room is dark and quiet.".into(),
                noun: None
            }]
        );
    }

    #[test]
    fn nouns_shorter_than_three_chars_are_ignored() {
        let segs = link_nouns("A is here. Go north.", &nouns(&["A", "is", "Go"]));
        assert!(segs.iter().all(|s| s.noun.is_none()));
    }

    #[test]
    fn matches_case_insensitively_preserving_original_surface_text() {
        let segs = link_nouns("A LANTERN glows softly.", &nouns(&["lantern"]));
        let noun = segs.iter().find(|s| s.noun.is_some()).unwrap();
        assert_eq!(noun.text, "LANTERN"); // original casing preserved
        assert_eq!(noun.noun.as_deref(), Some("LANTERN"));
    }

    #[test]
    fn handles_multiple_nouns_in_one_line_without_overlap() {
        let line = "The Skeleton guards the Iron Gate.";
        let segs = link_nouns(line, &nouns(&["Skeleton", "Iron Gate"]));
        let noun_texts: Vec<_> = segs
            .iter()
            .filter(|s| s.noun.is_some())
            .map(|s| s.text.clone())
            .collect();
        assert_eq!(noun_texts, vec!["Skeleton", "Iron Gate"]);
        assert_eq!(join(&segs), line);
    }

    #[test]
    fn an_empty_line_returns_a_single_plain_segment() {
        assert_eq!(
            link_nouns("", &nouns(&["Lantern"])),
            vec![Segment {
                text: "".into(),
                noun: None
            }]
        );
    }

    #[test]
    fn preserves_exact_text_with_noun_at_start_or_end() {
        let start = link_nouns("Lantern sits on the table.", &nouns(&["Lantern"]));
        assert_eq!(
            start[0],
            Segment {
                text: "Lantern".into(),
                noun: Some("Lantern".into())
            }
        );
        assert_eq!(join(&start), "Lantern sits on the table.");

        let line = "You pick up the Lantern";
        let end = link_nouns(line, &nouns(&["Lantern"]));
        assert_eq!(
            *end.last().unwrap(),
            Segment {
                text: "Lantern".into(),
                noun: Some("Lantern".into())
            }
        );
        assert_eq!(join(&end), line);
    }
}
