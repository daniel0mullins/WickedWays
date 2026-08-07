//! The editor document model.
//!
//! [`EditorDoc`] mirrors the author crate's `AuthorDoc` field-for-field — the studio
//! never invents an abstraction over the TOML surface, so it can never author
//! something the compiler rejects structurally. Its only addition is a **stable
//! editor id** per list entry ([`WithId`]): a monotonic counter, never persisted into
//! TOML, so UI selection, problem targets, and renames survive edits. Conversion is
//! total in both directions: import wraps a deserialized `AuthorDoc` with fresh ids;
//! export strips them.

use serde::{Deserialize, Serialize};
use wickedways_author::author_doc::{
    ArchetypeEntry, AuthorDoc, Behaviors, CacheEntry, CardEntryToml, ConditionEntry, ExitEntry,
    FormationEntry, ItemEntry, LootEntry, MechanicEntryToml, MobEntry, NpcEntry, RecipeEntry,
    RoomEntry, SceneEntry, VillainEntry,
};

pub use wickedways_assemble::description::CampaignOpts;

/// A list entry wrapped with its stable editor id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WithId<T> {
    pub id: u64,
    pub entry: T,
}

/// The studio's whole-campaign document: `AuthorDoc`, id-wrapped.
///
/// `victory` is split into its two ordered lists so each condition carries an id;
/// `behaviors` stays the author shape (its maps are keyed — the key IS the identity);
/// `villain` is a singleton and needs no id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditorDoc {
    pub title: String,
    pub start_room: Option<String>,
    pub opts: CampaignOpts,
    pub timeout_narration: Option<String>,
    pub archetypes: Vec<WithId<ArchetypeEntry>>,
    pub rooms: Vec<WithId<RoomEntry>>,
    pub exits: Vec<WithId<ExitEntry>>,
    pub items: Vec<WithId<ItemEntry>>,
    pub loot: Vec<WithId<LootEntry>>,
    pub caches: Vec<WithId<CacheEntry>>,
    pub recipes: Vec<WithId<RecipeEntry>>,
    pub scenes: Vec<WithId<SceneEntry>>,
    pub npcs: Vec<WithId<NpcEntry>>,
    pub mobs: Vec<WithId<MobEntry>>,
    pub formations: Vec<WithId<FormationEntry>>,
    pub mechanics: Vec<WithId<MechanicEntryToml>>,
    pub cards: Vec<WithId<CardEntryToml>>,
    pub villain: Option<VillainEntry>,
    pub behaviors: Behaviors,
    pub victory_win: Vec<WithId<ConditionEntry>>,
    pub victory_lose: Vec<WithId<ConditionEntry>>,
    next_id: u64,
}

fn wrap<T>(next: &mut u64, entries: Vec<T>) -> Vec<WithId<T>> {
    entries
        .into_iter()
        .map(|entry| {
            let id = *next;
            *next += 1;
            WithId { id, entry }
        })
        .collect()
}

fn strip<T: Clone>(entries: &[WithId<T>]) -> Vec<T> {
    entries.iter().map(|w| w.entry.clone()).collect()
}

impl EditorDoc {
    /// Wrap a parsed `AuthorDoc` with fresh editor ids (the import direction).
    #[must_use]
    pub fn from_author(doc: AuthorDoc) -> Self {
        let mut next = 1u64;
        let victory = doc.victory;
        Self {
            title: doc.title,
            start_room: doc.start_room,
            opts: doc.opts,
            timeout_narration: doc.timeout_narration,
            archetypes: wrap(&mut next, doc.archetypes),
            rooms: wrap(&mut next, doc.rooms),
            exits: wrap(&mut next, doc.exits),
            items: wrap(&mut next, doc.items),
            loot: wrap(&mut next, doc.loot),
            caches: wrap(&mut next, doc.caches),
            recipes: wrap(&mut next, doc.recipes),
            scenes: wrap(&mut next, doc.scenes),
            npcs: wrap(&mut next, doc.npcs),
            mobs: wrap(&mut next, doc.mobs),
            formations: wrap(&mut next, doc.formations),
            mechanics: wrap(&mut next, doc.mechanics),
            cards: wrap(&mut next, doc.cards),
            villain: doc.villain,
            behaviors: doc.behaviors,
            victory_win: wrap(&mut next, victory.win),
            victory_lose: wrap(&mut next, victory.lose),
            next_id: next,
        }
    }

    /// Strip editor ids back to the author surface (the export direction).
    #[must_use]
    pub fn to_author(&self) -> AuthorDoc {
        AuthorDoc {
            title: self.title.clone(),
            start_room: self.start_room.clone(),
            opts: self.opts.clone(),
            archetypes: strip(&self.archetypes),
            rooms: strip(&self.rooms),
            exits: strip(&self.exits),
            items: strip(&self.items),
            loot: strip(&self.loot),
            caches: strip(&self.caches),
            recipes: strip(&self.recipes),
            scenes: strip(&self.scenes),
            npcs: strip(&self.npcs),
            mobs: strip(&self.mobs),
            formations: strip(&self.formations),
            mechanics: strip(&self.mechanics),
            villain: self.villain.clone(),
            cards: strip(&self.cards),
            behaviors: self.behaviors.clone(),
            victory: wickedways_author::author_doc::Victory {
                win: strip(&self.victory_win),
                lose: strip(&self.victory_lose),
            },
            timeout_narration: self.timeout_narration.clone(),
        }
    }

    /// A fresh empty campaign.
    #[must_use]
    pub fn new_blank(title: &str) -> Self {
        Self::from_author(AuthorDoc {
            title: title.to_string(),
            start_room: None,
            opts: CampaignOpts::default(),
            archetypes: Vec::new(),
            rooms: Vec::new(),
            exits: Vec::new(),
            items: Vec::new(),
            loot: Vec::new(),
            caches: Vec::new(),
            recipes: Vec::new(),
            scenes: Vec::new(),
            npcs: Vec::new(),
            mobs: Vec::new(),
            formations: Vec::new(),
            mechanics: Vec::new(),
            villain: None,
            cards: Vec::new(),
            behaviors: Behaviors::default(),
            victory: wickedways_author::author_doc::Victory::default(),
            timeout_narration: None,
        })
    }

    /// Mint the next editor id (monotonic per document).
    pub fn mint(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Every declared room name, in authored order (pickers + integrity checks).
    #[must_use]
    pub fn room_names(&self) -> Vec<String> {
        self.rooms.iter().map(|r| r.entry.name.clone()).collect()
    }

    /// Every declared item key, in authored order (pickers + integrity checks).
    #[must_use]
    pub fn item_keys(&self) -> Vec<String> {
        self.items.iter().map(|i| i.entry.key.clone()).collect()
    }
}

/// The `ItemType` picker vocabulary. `lower_item` silently defaults an unrecognized
/// string, so the UI must constrain these — free text is forbidden by the spec.
pub const ITEM_TYPES: &[&str] = &[
    "consumable",
    "armor",
    "weapon",
    "throwable",
    "accessory",
    "key",
];

/// The `SlotKind` picker vocabulary (same silent-default hazard).
pub const SLOT_KINDS: &[&str] = &["hand", "finger", "wrist", "head", "torso", "legs", "feet"];

/// The `StatType` picker vocabulary (same silent-default hazard).
pub const STAT_TYPES: &[&str] = &["health", "sanity", "energy"];

/// The eight compass directions, in the engine's wire spelling
/// (`Direction::as_key`).
pub const DIRECTIONS: &[&str] = &[
    "north",
    "south",
    "east",
    "west",
    "northeast",
    "northwest",
    "southeast",
    "southwest",
];

/// The compass opposite — the return leg's direction for the reverse-exit
/// convenience.
#[must_use]
pub fn opposite_direction(dir: &str) -> Option<&'static str> {
    Some(match dir {
        "north" => "south",
        "south" => "north",
        "east" => "west",
        "west" => "east",
        "northeast" => "southwest",
        "southwest" => "northeast",
        "northwest" => "southeast",
        "southeast" => "northwest",
        _ => return None,
    })
}

/// The scene `phase` vocabulary.
pub const SCENE_PHASES: &[&str] = &["enter", "exit"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_doc_round_trips_to_author_and_back() {
        let doc = EditorDoc::new_blank("Test");
        let author = doc.to_author();
        assert_eq!(author.title, "Test");
        let back = EditorDoc::from_author(author);
        assert_eq!(back.title, doc.title);
    }

    #[test]
    fn from_author_assigns_unique_ids() {
        let src = r#"
            title = "Two Rooms"
            [[rooms]]
            name = "A"
            description = "a"
            [[rooms]]
            name = "B"
            description = "b"
            [[exits]]
            from = "A"
            to = "B"
            direction = "north"
        "#;
        let author: AuthorDoc = toml::from_str(src).unwrap();
        let doc = EditorDoc::from_author(author);
        let mut ids: Vec<u64> = doc.rooms.iter().map(|r| r.id).collect();
        ids.extend(doc.exits.iter().map(|e| e.id));
        let unique: std::collections::BTreeSet<u64> = ids.iter().copied().collect();
        assert_eq!(
            unique.len(),
            ids.len(),
            "ids must be unique across families"
        );
    }

    #[test]
    fn mint_never_reuses_an_id() {
        let src = r#"
            title = "T"
            [[rooms]]
            name = "A"
            description = "a"
        "#;
        let mut doc = EditorDoc::from_author(toml::from_str(src).unwrap());
        let existing: Vec<u64> = doc.rooms.iter().map(|r| r.id).collect();
        let fresh = doc.mint();
        assert!(!existing.contains(&fresh));
        assert_ne!(doc.mint(), fresh);
    }

    #[test]
    fn every_direction_has_a_consistent_opposite() {
        for d in DIRECTIONS {
            let opp = opposite_direction(d).expect("opposite exists");
            assert_eq!(opposite_direction(opp), Some(*d));
        }
        assert_eq!(opposite_direction("sideways"), None);
    }

    #[test]
    fn editor_doc_survives_a_storage_json_round_trip() {
        let src = r#"
            title = "T"
            startRoom = "A"
            [[rooms]]
            name = "A"
            description = "a"
            [[exits]]
            from = "A"
            to = "A"
            direction = "north"
            initialState = { unlocked = false }
        "#;
        let doc = EditorDoc::from_author(toml::from_str(src).unwrap());
        let json = serde_json::to_string(&doc).unwrap();
        let back: EditorDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc, "storage blobs are JSON of the EditorDoc");
    }
}
