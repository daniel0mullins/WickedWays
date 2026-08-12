//! The CRT command parser.
//!
//! A pure function turning a line of terminal
//! input into a [`ParseResult`] against the current scope (the entities the player can name). It is
//! framework-free and browser-free, so it is unit-tested exhaustively on the host; the shell wires
//! its output — [`Intent`]s become sync `Command`s, queries render locally.
//!
//! Takes `&[ScopeEntity]` (the ViewModel's `scope`) rather than the whole ViewModel — the scope is
//! the only input parsing needs — which keeps the parser and its tests trivial.

use wickedways_core::world::direction::Direction;
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ScopeEntity;

/// What a parsed line resolves to.
#[derive(Clone, Debug, PartialEq)]
pub enum ParseResult {
    Intent(Intent),
    Query(Query),
    Examine(ScopeEntity),
    Meta(Meta),
    Ambiguous(Vec<ScopeEntity>),
    Error(String),
}

/// A zero-noun informational query (rendered locally, no command).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Query {
    Look,
    Inventory,
    Exits,
    Help,
}

/// A client/session meta command (save/undo/map/…), handled by the surface, not the engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Meta {
    Save,
    Restore,
    Undo,
    Restart,
    Fullscreen,
    Audio,
    Map,
}

/// `north`/`n`/… → a compass [`Direction`].
fn parse_dir(s: &str) -> Option<Direction> {
    use Direction::*;
    Some(match s {
        "north" | "n" => North,
        "south" | "s" => South,
        "east" | "e" => East,
        "west" | "w" => West,
        "northeast" | "ne" => Northeast,
        "northwest" | "nw" => Northwest,
        "southeast" | "se" => Southeast,
        "southwest" | "sw" => Southwest,
        _ => return None,
    })
}

/// Leading filler stripped from a noun phrase (articles + the common `look at`/`give to`/… prepositions).
const STOP_WORDS: &[&str] = &["the", "a", "an", "at", "to", "with", "on"];

fn is_stop(w: &str) -> bool {
    STOP_WORDS.contains(&w)
}

/// Whether `verb` is a verb that takes a noun (take/attack/open/…).
fn is_noun_verb(verb: &str) -> bool {
    matches!(
        verb,
        "take"
            | "get"
            | "drop"
            | "attack"
            | "kill"
            | "hit"
            | "equip"
            | "wear"
            | "wield"
            | "light"
            | "unequip"
            | "remove"
            | "extinguish"
            | "use"
            | "open"
            | "harvest"
            | "scavenge"
            | "gather"
            | "craft"
            | "forge"
            | "make"
            | "repair"
            | "mend"
            | "fix"
            | "destroy"
            | "scrap"
            | "break"
    )
}

/// A verb needing a resolved noun → an `Intent`, or an error string.
fn noun_verb(verb: &str, t: &ScopeEntity) -> Option<Result<Intent, String>> {
    let id = t.id.clone();
    let carry_err =
        || Err("That's not something you can carry — try taking what's inside it.".to_string());
    Some(match verb {
        "take" | "get" => {
            if t.kind == "loot" {
                carry_err()
            } else {
                Ok(Intent::Take { target_id: id })
            }
        }
        "drop" => Ok(Intent::Drop { target_id: id }),
        "attack" | "kill" | "hit" => Ok(Intent::Attack { target_id: id }),
        "equip" | "wear" | "wield" | "light" => Ok(Intent::Equip { target_id: id }),
        "unequip" | "remove" | "extinguish" => Ok(Intent::Unequip { target_id: id }),
        "use" => Ok(Intent::Use { target_id: id }),
        "open" => {
            if t.kind == "loot" {
                Ok(Intent::Open { target_id: id })
            } else {
                Err("You can't open that.".to_string())
            }
        }
        // Materials & crafting. Each verb wants a specific kind of target: a cache to
        // harvest, a recipe to craft, a held item to repair or scrap.
        "harvest" | "scavenge" | "gather" => {
            if t.kind == "cache" {
                Ok(Intent::Harvest { target_id: id })
            } else {
                Err("There's nothing to harvest there.".to_string())
            }
        }
        "craft" | "forge" | "make" => {
            if t.kind == "recipe" {
                Ok(Intent::Craft { recipe_id: id })
            } else {
                Err("You don't know how to craft that.".to_string())
            }
        }
        "repair" | "mend" | "fix" => {
            if t.kind == "item" {
                Ok(Intent::Repair { target_id: id })
            } else {
                Err("You can't repair that.".to_string())
            }
        }
        "destroy" | "scrap" | "break" => {
            if t.kind == "item" {
                Ok(Intent::Destroy { target_id: id })
            } else {
                Err("You can't break that down.".to_string())
            }
        }
        _ => return None,
    })
}

/// Parses one line of input against `scope`.
pub fn parse(input: &str, scope: &[ScopeEntity]) -> ParseResult {
    let lowered = input.trim().to_lowercase();
    let tokens: Vec<&str> = lowered.split_whitespace().collect();
    let Some(&verb) = tokens.first() else {
        return ParseResult::Error("Say something.".into());
    };

    // Bare direction or "go/walk <dir>".
    if let Some(dir) = parse_dir(verb) {
        return ParseResult::Intent(Intent::Move { dir });
    }
    if verb == "go" || verb == "walk" {
        return match tokens.get(1).and_then(|t| parse_dir(t)) {
            Some(dir) => ParseResult::Intent(Intent::Move { dir }),
            None => ParseResult::Error("Go where?".into()),
        };
    }

    // Meta verbs.
    match verb {
        "save" => return ParseResult::Meta(Meta::Save),
        "restore" | "load" => return ParseResult::Meta(Meta::Restore),
        "undo" => return ParseResult::Meta(Meta::Undo),
        "restart" => return ParseResult::Meta(Meta::Restart),
        "fullscreen" | "fs" => return ParseResult::Meta(Meta::Fullscreen),
        "audio" | "sound" | "mute" => return ParseResult::Meta(Meta::Audio),
        "map" => return ParseResult::Meta(Meta::Map),
        _ => {}
    }

    // Zero-noun queries + wait.
    match verb {
        "inventory" | "i" | "inv" => return ParseResult::Query(Query::Inventory),
        "exits" => return ParseResult::Query(Query::Exits),
        "help" | "?" => return ParseResult::Query(Query::Help),
        "wait" | "z" => return ParseResult::Intent(Intent::Wait),
        _ => {}
    }

    // talk/speak/ask <npc> with an optional quoted prompt (case preserved from raw input).
    if verb == "talk" || verb == "speak" || verb == "ask" {
        let (prompt, remainder) = extract_quoted_prompt(input);
        let target = remainder
            .trim()
            .to_lowercase()
            .split_whitespace()
            .skip(1)
            .filter(|t| !is_stop(t))
            .collect::<Vec<_>>()
            .join(" ");
        if target.is_empty() {
            return ParseResult::Error(format!("{verb} to whom?"));
        }
        return resolve_then(verb, &target, scope, |t| {
            ParseResult::Intent(Intent::Talk {
                npc_id: t.id.clone(),
                prompt: prompt.clone(),
            })
        });
    }

    // play <card> [to/at <room>] — the Villain's card action. The optional
    // trailing room (Shadow Step's destination) is split off at the FIRST
    // bare "to"/"at" and carried as a NAME — the command layer resolves it
    // against the live world, so the parser needs no room scope.
    if verb == "play" || verb == "cast" {
        let args: Vec<&str> = tokens.iter().skip(1).copied().collect();
        let split = args.iter().position(|t| *t == "to" || *t == "at");
        let (card_tokens, room_tokens) = match split {
            Some(i) => (&args[..i], &args[i + 1..]),
            None => (&args[..], &[][..]),
        };
        let card_phrase = card_tokens
            .iter()
            .filter(|t| !is_stop(t))
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        if card_phrase.is_empty() {
            return ParseResult::Error("Play which card?".into());
        }
        let room = {
            let name = room_tokens
                .iter()
                .filter(|t| !is_stop(t))
                .copied()
                .collect::<Vec<_>>()
                .join(" ");
            (!name.is_empty()).then_some(name)
        };
        return resolve_then(verb, &card_phrase, scope, |t| {
            ParseResult::Intent(Intent::PlayCard {
                card_key: t.id.clone(),
                room: room.clone(),
            })
        });
    }

    // mulligan <card>, <card>, <card> — discard three, draw three. The only
    // comma-separated argument list in the grammar.
    if verb == "mulligan" || verb == "redraw" {
        let rest = lowered[verb.len()..].trim();
        if rest.is_empty() {
            return ParseResult::Error(
                "Mulligan which cards? Name three, separated by commas.".into(),
            );
        }
        let mut card_keys: Vec<String> = Vec::new();
        for fragment in rest.split(',') {
            let phrase = fragment
                .split_whitespace()
                .filter(|t| !is_stop(t))
                .collect::<Vec<_>>()
                .join(" ");
            if phrase.is_empty() {
                continue;
            }
            let matches: Vec<&ScopeEntity> = resolve(&phrase, scope)
                .into_iter()
                .filter(|e| verb_targets(verb, &e.kind))
                .collect();
            match matches.len() {
                0 => {
                    return ParseResult::Error(format!(
                        "You're not holding a card called \"{phrase}\"."
                    ))
                }
                1 => card_keys.push(matches[0].id.clone()),
                _ => return ParseResult::Ambiguous(matches.into_iter().cloned().collect()),
            }
        }
        return ParseResult::Intent(Intent::Mulligan { card_keys });
    }

    let noun_phrase = tokens
        .iter()
        .skip(1)
        .filter(|t| !is_stop(t))
        .copied()
        .collect::<Vec<_>>()
        .join(" ");

    // examine / look-at / read — resolve then examine; bare `look`/`l` is the room query.
    if matches!(verb, "examine" | "x" | "look-at" | "read" | "look" | "l") {
        if noun_phrase.is_empty() {
            return ParseResult::Query(Query::Look);
        }
        return resolve_then(verb, &noun_phrase, scope, |t| {
            ParseResult::Examine(t.clone())
        });
    }

    // Noun verbs (take/drop/attack/…).
    if !is_noun_verb(verb) {
        return ParseResult::Error(format!("I don't know how to \"{verb}\"."));
    }
    if noun_phrase.is_empty() {
        return ParseResult::Error(format!("{verb} what?"));
    }
    resolve_then(verb, &noun_phrase, scope, |t| match noun_verb(verb, t) {
        Some(Ok(intent)) => ParseResult::Intent(intent),
        Some(Err(msg)) => ParseResult::Error(msg),
        None => ParseResult::Error(format!("I don't know how to \"{verb}\".")),
    })
}

/// Whether a scope entity of `kind` is a legal target for `verb`. The virtual crafting scope
/// entries (`recipe`, `cache`) are namespaced to their own verbs so they never collide with a
/// same-named real item: only `craft` sees recipes, only `harvest` sees caches, and every physical
/// verb ignores both (e.g. `equip ward charm` resolves the held item, not the recipe of the same
/// name). `examine` can look at anything physical or a cache, but a recipe lives in the panel, not
/// the room.
fn verb_targets(verb: &str, kind: &str) -> bool {
    match verb {
        "craft" | "forge" | "make" => kind == "recipe",
        "harvest" | "scavenge" | "gather" => kind == "cache",
        // Only the card verbs see the Villain's hand; card faces live in the
        // panel, so `examine` (like recipes) ignores them.
        "play" | "cast" | "mulligan" | "redraw" => kind == "card",
        "examine" | "x" | "look-at" | "read" | "look" | "l" => kind != "recipe" && kind != "card",
        _ => kind != "recipe" && kind != "cache" && kind != "card",
    }
}

/// Resolve `phrase` against the `verb`-relevant subset of `scope`; 0 → error, >1 → ambiguous,
/// 1 → `build`. Filtering by verb before counting is what keeps a recipe and a same-named item from
/// reading as ambiguous.
fn resolve_then(
    verb: &str,
    phrase: &str,
    scope: &[ScopeEntity],
    build: impl Fn(&ScopeEntity) -> ParseResult,
) -> ParseResult {
    let matches: Vec<&ScopeEntity> = resolve(phrase, scope)
        .into_iter()
        .filter(|e| verb_targets(verb, &e.kind))
        .collect();
    match matches.len() {
        0 => ParseResult::Error("You don't see that here.".into()),
        1 => build(matches[0]),
        _ => ParseResult::Ambiguous(matches.into_iter().cloned().collect()),
    }
}

/// Match a phrase against each entity's name + aliases (exact first, then substring), deduped by id.
fn resolve<'a>(phrase: &str, scope: &'a [ScopeEntity]) -> Vec<&'a ScopeEntity> {
    let exact: Vec<&ScopeEntity> = scope
        .iter()
        .filter(|e| e.aliases.iter().any(|a| a == phrase) || e.name.to_lowercase() == phrase)
        .collect();
    if !exact.is_empty() {
        return dedupe(exact);
    }
    let partial = scope
        .iter()
        .filter(|e| {
            e.aliases
                .iter()
                .any(|a| a.contains(phrase) || phrase.contains(a.as_str()))
                || e.name.to_lowercase().contains(phrase)
        })
        .collect();
    dedupe(partial)
}

fn dedupe(entities: Vec<&ScopeEntity>) -> Vec<&ScopeEntity> {
    let mut seen = std::collections::HashSet::new();
    entities
        .into_iter()
        .filter(|e| seen.insert(e.id.clone()))
        .collect()
}

/// Pull the first `"…"` segment from raw input: its trimmed contents (None if empty/absent) and the
/// input with that segment removed.
fn extract_quoted_prompt(input: &str) -> (Option<String>, String) {
    if let Some(open) = input.find('"') {
        if let Some(rel_close) = input[open + 1..].find('"') {
            let close = open + 1 + rel_close;
            let prompt = input[open + 1..close].trim().to_string();
            let mut remainder = String::with_capacity(input.len());
            remainder.push_str(&input[..open]);
            remainder.push_str(&input[close + 1..]);
            return (
                if prompt.is_empty() {
                    None
                } else {
                    Some(prompt)
                },
                remainder,
            );
        }
    }
    (None, input.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ent(id: &str, name: &str, kind: &str, aliases: &[&str]) -> ScopeEntity {
        ScopeEntity {
            id: id.into(),
            name: name.into(),
            kind: kind.into(),
            aliases: aliases
                .iter()
                .map(std::string::ToString::to_string)
                .collect(),
            health: None,
            image: None,
            equippable: None,
            usable: None,
            has_lore: None,
            droppable: None,
            destroyable: None,
            damaged: None,
            defeated: None,
            talkable: None,
            player: None,
        }
    }

    fn scope() -> Vec<ScopeEntity> {
        vec![
            ent("m:rat", "Rat", "occupant", &["rat"]),
            ent("i:torch", "Torch", "item", &["torch", "brand"]),
            ent("l:chest", "Chest", "loot", &["chest"]),
        ]
    }

    /// A villain hand: the three shipped cards as `kind: "card"` scope entities
    /// (the shape the core view mints for the active villain).
    fn card_scope() -> Vec<ScopeEntity> {
        vec![
            ent(
                "wicked:lights-out",
                "Lights Out",
                "card",
                &["lights out", "wicked:lights-out"],
            ),
            ent("wicked:ruin", "Ruin", "card", &["ruin", "wicked:ruin"]),
            ent(
                "wicked:shadow-step",
                "Shadow Step",
                "card",
                &["shadow step", "wicked:shadow-step"],
            ),
        ]
    }

    #[test]
    fn play_resolves_a_card_by_face_name() {
        assert_eq!(
            parse("play lights out", &card_scope()),
            ParseResult::Intent(Intent::PlayCard {
                card_key: "wicked:lights-out".into(),
                room: None,
            })
        );
    }

    #[test]
    fn play_splits_a_room_target_at_to() {
        assert_eq!(
            parse("play shadow step to the gallery", &card_scope()),
            ParseResult::Intent(Intent::PlayCard {
                card_key: "wicked:shadow-step".into(),
                room: Some("gallery".into()),
            })
        );
    }

    #[test]
    fn play_without_a_card_asks_which() {
        assert_eq!(
            parse("play", &card_scope()),
            ParseResult::Error("Play which card?".into())
        );
    }

    #[test]
    fn mulligan_parses_a_comma_list() {
        assert_eq!(
            parse("mulligan lights out, ruin, shadow step", &card_scope()),
            ParseResult::Intent(Intent::Mulligan {
                card_keys: vec![
                    "wicked:lights-out".into(),
                    "wicked:ruin".into(),
                    "wicked:shadow-step".into(),
                ],
            })
        );
    }

    #[test]
    fn mulligan_rejects_an_unknown_card() {
        assert_eq!(
            parse("mulligan lights out, nonsense, ruin", &card_scope()),
            ParseResult::Error("You're not holding a card called \"nonsense\".".into())
        );
    }

    #[test]
    fn cards_are_invisible_to_physical_verbs() {
        // The verb-target namespace keeps a card named like an item from ever
        // resolving for take/equip/etc. — and keeps `play` from seeing items.
        let mut s = card_scope();
        s.push(ent("i:torch", "Torch", "item", &["torch"]));
        assert_eq!(
            parse("take lights out", &s),
            ParseResult::Error("You don't see that here.".into())
        );
        assert_eq!(
            parse("play torch", &s),
            ParseResult::Error("You don't see that here.".into())
        );
    }

    #[test]
    fn bare_direction_and_go_move() {
        assert_eq!(
            parse("north", &[]),
            ParseResult::Intent(Intent::Move {
                dir: Direction::North
            })
        );
        assert_eq!(
            parse("n", &[]),
            ParseResult::Intent(Intent::Move {
                dir: Direction::North
            })
        );
        assert_eq!(
            parse("go west", &[]),
            ParseResult::Intent(Intent::Move {
                dir: Direction::West
            })
        );
        assert_eq!(parse("go", &[]), ParseResult::Error("Go where?".into()));
    }

    #[test]
    fn empty_input_and_unknown_verb() {
        assert_eq!(
            parse("   ", &[]),
            ParseResult::Error("Say something.".into())
        );
        assert_eq!(
            parse("frobnicate", &[]),
            ParseResult::Error("I don't know how to \"frobnicate\".".into())
        );
    }

    #[test]
    fn meta_and_queries() {
        assert_eq!(parse("save", &[]), ParseResult::Meta(Meta::Save));
        assert_eq!(parse("map", &[]), ParseResult::Meta(Meta::Map));
        assert_eq!(
            parse("inventory", &[]),
            ParseResult::Query(Query::Inventory)
        );
        assert_eq!(parse("i", &[]), ParseResult::Query(Query::Inventory));
        assert_eq!(parse("exits", &[]), ParseResult::Query(Query::Exits));
        assert_eq!(parse("look", &[]), ParseResult::Query(Query::Look));
        assert_eq!(parse("wait", &[]), ParseResult::Intent(Intent::Wait));
    }

    #[test]
    fn noun_verbs_resolve_the_target() {
        let s = scope();
        assert_eq!(
            parse("attack rat", &s),
            ParseResult::Intent(Intent::Attack {
                target_id: "m:rat".into()
            })
        );
        assert_eq!(
            parse("take torch", &s),
            ParseResult::Intent(Intent::Take {
                target_id: "i:torch".into()
            })
        );
        assert_eq!(
            parse("take the torch", &s),
            ParseResult::Intent(Intent::Take {
                target_id: "i:torch".into()
            })
        );
        assert_eq!(
            parse("wield brand", &s),
            ParseResult::Intent(Intent::Equip {
                target_id: "i:torch".into()
            })
        );
        assert_eq!(
            parse("open chest", &s),
            ParseResult::Intent(Intent::Open {
                target_id: "l:chest".into()
            })
        );
    }

    #[test]
    fn loot_cannot_be_taken_and_items_cannot_be_opened() {
        let s = scope();
        assert!(
            matches!(parse("take chest", &s), ParseResult::Error(m) if m.contains("can carry"))
        );
        assert!(
            matches!(parse("open torch", &s), ParseResult::Error(m) if m == "You can't open that.")
        );
    }

    #[test]
    fn missing_or_unseen_noun() {
        let s = scope();
        assert_eq!(parse("take", &s), ParseResult::Error("take what?".into()));
        assert_eq!(
            parse("attack ghost", &s),
            ParseResult::Error("You don't see that here.".into())
        );
    }

    #[test]
    fn examine_resolves_and_bare_look_is_a_query() {
        let s = scope();
        assert_eq!(parse("look", &s), ParseResult::Query(Query::Look));
        assert_eq!(parse("examine rat", &s), ParseResult::Examine(s[0].clone()));
        assert_eq!(
            parse("look at torch", &s),
            ParseResult::Examine(s[1].clone())
        );
    }

    #[test]
    fn ambiguous_when_two_entities_share_a_substring() {
        let s = vec![
            ent("k:1", "Brass Key", "item", &["key"]),
            ent("k:2", "Iron Key", "item", &["key"]),
        ];
        match parse("take key", &s) {
            ParseResult::Ambiguous(c) => assert_eq!(c.len(), 2),
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn crafting_verbs_resolve_by_kind() {
        let s = vec![
            ent("cache:vein", "Iron Vein", "cache", &["iron vein", "vein"]),
            ent("blade", "Iron Blade", "recipe", &["iron blade"]),
            ent("i:sword", "Sword", "item", &["sword"]),
        ];
        assert_eq!(
            parse("harvest vein", &s),
            ParseResult::Intent(Intent::Harvest {
                target_id: "cache:vein".into()
            })
        );
        assert_eq!(
            parse("craft iron blade", &s),
            ParseResult::Intent(Intent::Craft {
                recipe_id: "blade".into()
            })
        );
        assert_eq!(
            parse("repair sword", &s),
            ParseResult::Intent(Intent::Repair {
                target_id: "i:sword".into()
            })
        );
        assert_eq!(
            parse("scrap sword", &s),
            ParseResult::Intent(Intent::Destroy {
                target_id: "i:sword".into()
            })
        );
    }

    #[test]
    fn crafting_verbs_ignore_out_of_namespace_targets() {
        let s = vec![
            ent("i:sword", "Sword", "item", &["sword"]),
            ent("cache:vein", "Iron Vein", "cache", &["vein"]),
            ent("m:rat", "Rat", "occupant", &["rat"]),
        ];
        // A virtual target of the wrong verb-namespace simply isn't in scope for that verb.
        assert!(
            matches!(parse("harvest sword", &s), ParseResult::Error(m) if m.contains("don't see"))
        );
        assert!(
            matches!(parse("craft sword", &s), ParseResult::Error(m) if m.contains("don't see"))
        );
        assert!(
            matches!(parse("repair vein", &s), ParseResult::Error(m) if m.contains("don't see"))
        );
        // A physical target of the wrong kind still gets the specific reason from `noun_verb`.
        assert!(
            matches!(parse("repair rat", &s), ParseResult::Error(m) if m.contains("can't repair"))
        );
    }

    #[test]
    fn a_recipe_never_collides_with_a_same_named_held_item() {
        // Regression: after crafting, the held Ward Charm (item) and the Ward Charm recipe both live
        // in scope. A physical verb must resolve the item without ambiguity; `craft` still finds the
        // recipe.
        let s = vec![
            ent(
                "item:charm-1",
                "Ward Charm",
                "item",
                &["ward charm", "charm"],
            ),
            ent("ward-charm", "Ward Charm", "recipe", &["ward charm"]),
        ];
        assert_eq!(
            parse("equip ward charm", &s),
            ParseResult::Intent(Intent::Equip {
                target_id: "item:charm-1".into()
            })
        );
        assert_eq!(
            parse("use charm", &s),
            ParseResult::Intent(Intent::Use {
                target_id: "item:charm-1".into()
            })
        );
        assert_eq!(
            parse("craft ward charm", &s),
            ParseResult::Intent(Intent::Craft {
                recipe_id: "ward-charm".into()
            })
        );
    }

    #[test]
    fn talk_with_a_quoted_prompt() {
        let s = vec![ent("npc:keeper", "Keeper", "occupant", &["keeper"])];
        assert_eq!(
            parse("talk to keeper \"how do I get out\"", &s),
            ParseResult::Intent(Intent::Talk {
                npc_id: "npc:keeper".into(),
                prompt: Some("how do I get out".into())
            }),
        );
        assert_eq!(
            parse("talk keeper", &s),
            ParseResult::Intent(Intent::Talk {
                npc_id: "npc:keeper".into(),
                prompt: None
            }),
        );
        assert_eq!(
            parse("talk", &s),
            ParseResult::Error("talk to whom?".into())
        );
    }
}
