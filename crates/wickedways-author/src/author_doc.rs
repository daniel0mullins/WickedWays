use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorDoc {
    pub title: String,
    #[serde(default)]
    pub start_room: Option<String>,
    #[serde(default)]
    pub rooms: Vec<RoomEntry>,
    #[serde(default)]
    pub exits: Vec<ExitEntry>,
    #[serde(default)]
    pub items: Vec<ItemEntry>,
    #[serde(default)]
    pub loot: Vec<LootEntry>,
    #[serde(default)]
    pub scenes: Vec<SceneEntry>,
    #[serde(default)]
    pub behaviors: Behaviors,
    #[serde(default)]
    pub victory: Victory,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomEntry { pub name: String, pub description: String }

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitEntry {
    pub from: String,
    pub to: String,
    pub direction: String,
    #[serde(default)] pub behavior: Option<String>,
    #[serde(default)] pub one_way: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemEntry {
    pub key: String,
    pub name: String,
    #[serde(default)] pub key_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LootEntry { pub name: String, pub room: String, pub items: Vec<String>,
    #[serde(default)] pub description: Option<String> }

/// A scene attached to a room (`[[scenes]]`). Mirrors the description's
/// `SceneDef { room, key, phase?, initialState? }`. `phase` selects the
/// enter/exit hook the SceneDef attaches to (default `"enter"`); `initial_state`
/// seeds the scene's state map when present.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneEntry {
    pub room: String,
    pub key: String,
    #[serde(default)] pub phase: Option<String>,
    #[serde(default)] pub initial_state: Option<toml::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Behaviors {
    #[serde(default)] pub exit: BTreeMap<String, ExitBehaviorEntry>,
    #[serde(default)] pub scene: BTreeMap<String, SceneBehaviorEntry>,
}

/// A `[behaviors.scene.<key>]` body. `can_play` is an expression string gating
/// whether the scene may play; `on_enter`/`on_exit` are statement-block bodies
/// (the `'''...'''` grammar). Each is optional (absent = no-op / always plays).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneBehaviorEntry {
    #[serde(default)] pub can_play: Option<String>,
    #[serde(default)] pub on_enter: Option<String>,
    #[serde(default)] pub on_exit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitBehaviorEntry {
    pub can_pass: String,
    #[serde(default)] pub pass_message: Option<String>,
    #[serde(default)] pub fail_message: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Victory {
    #[serde(default)] pub win: BTreeMap<String, ConditionEntry>,
    #[serde(default)] pub lose: BTreeMap<String, ConditionEntry>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionEntry { pub test: String, #[serde(default)] pub narration: Option<String> }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_minimal_surface() {
        let src = r#"
            title = "Vault"
            startRoom = "Hall"
            [[rooms]]
            name = "Hall"
            description = "A cold stone hall."
            [[exits]]
            from = "Hall"
            to = "Vault"
            direction = "north"
            behavior = "vault-door"
            [behaviors.exit.vault-door]
            canPass = "hasKey(actor, 'vault')"
            failMessage = "Locked."
            [victory.win.reached-vault]
            test = "party[0].room.name == 'Vault'"
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.title, "Vault");
        assert_eq!(doc.start_room.as_deref(), Some("Hall"));
        assert_eq!(doc.rooms.len(), 1);
        assert_eq!(doc.exits[0].behavior.as_deref(), Some("vault-door"));
        assert_eq!(doc.behaviors.exit["vault-door"].can_pass, "hasKey(actor, 'vault')");
        assert_eq!(doc.victory.win["reached-vault"].test, "party[0].room.name == 'Vault'");
    }

    #[test]
    fn parses_the_scene_surface() {
        let src = r#"
            title = "Scene"
            [[scenes]]
            room = "Threshold"
            key = "threshold-draft"
            phase = "enter"
            [behaviors.scene.threshold-draft]
            canPlay = "!stateGet('seen', false)"
            onEnter = '''
              guard round == 0
              when !stateGet('revealed', false) {
                emit cue('A cold draft stirs the dust of the threshold.')
                set state.revealed = true
              }
              set state.seen = true
            '''
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.scenes.len(), 1);
        assert_eq!(doc.scenes[0].room, "Threshold");
        assert_eq!(doc.scenes[0].key, "threshold-draft");
        assert_eq!(doc.scenes[0].phase.as_deref(), Some("enter"));
        assert!(doc.scenes[0].initial_state.is_none());
        let sb = &doc.behaviors.scene["threshold-draft"];
        assert_eq!(sb.can_play.as_deref(), Some("!stateGet('seen', false)"));
        assert!(sb.on_enter.as_deref().unwrap().contains("guard round == 0"));
        assert!(sb.on_enter.as_deref().unwrap().contains("emit cue("));
        assert!(sb.on_enter.as_deref().unwrap().contains("set state.seen = true"));
        assert!(sb.on_exit.is_none());
    }
}
