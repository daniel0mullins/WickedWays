//! The sync [`SyncAuthority`] — server + single-player resolution (Phase 2c, sub-project B).
//!
//! Mirrors `src/lib/sync/authority.ts`: `submit` runs **authorize → apply (restoring from the
//! pre-image on a [`ProceduralViolation`]) → diff → commit**, re-deriving the [`Delta`] from the
//! command itself and appending an ordered [`LogEntry`]. The authoritative state is never left
//! half-mutated. Named `SyncAuthority` to disambiguate from the single-player engine handle
//! (`wickedways-wasm`'s `Authority`).
//!
//! **Scope (MVP).** [`apply_command`] dispatches the command subset the engine already supports
//! (move/attack/equip/unequip/use/pickUp/drop/talk + begin/end/nextPlayer + join/seat/gm). Every
//! other command kind is a clean [`SubmitResult::Denied`] (never a panic), pending sub-project A1/A2's
//! remaining engine-action ports (craft/repair/harvest/light/loot-box/key transfer).
//!
//! **Denial parity (deferred).** The TS `resolver.apply` resolves every argument id through an
//! entity index that throws on a miss, so a command naming a nonexistent id is *denied*. The Rust
//! engine methods validate ids themselves, but not always identically (e.g. `move_to` to an
//! unknown room is a quiet no-op rather than a violation). Exact invalid-id denial parity with the
//! oracle is aligned when B's differential gate replays TS-emitted goldens — the machinery here
//! (authorize → apply → restore-on-violation → diff → commit → log) is what this slice proves.

use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::error::ProceduralViolation;
use crate::presentation::{MechanicCue, PresentationCue};
use crate::world::descriptor::Catalog;
use crate::world::snapshot::CampaignSnapshot;
use crate::world::World;

use super::authorize::{authorize, AuthResult};
use super::command::Command;
use super::delta::{diff, Delta};

/// An ordered, broadcast entry: the command and the delta it produced. Serializes as the wire
/// `WireLogEntry` (camelCase). Mirrors the TS `LogEntry`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub seq: u64,
    pub base_seq: u64,
    pub command: Command,
    pub delta: Delta,
}

/// The outcome of [`SyncAuthority::submit`]: committed with its delta, or a terminal denial.
/// A plain Rust enum — the wire framing (the TS `committed{seq,delta}` / `denied{reason}`
/// server messages) is sub-project C's concern.
#[derive(Clone, Debug, PartialEq)]
pub enum SubmitResult {
    Committed { seq: u64, delta: Delta },
    Denied { reason: String },
}

/// Construction options for a [`SyncAuthority`].
#[derive(Clone, Debug)]
pub struct AuthorityOpts {
    /// Checkpoint every N commits (the `load_snapshot` freshness cadence). Default 20.
    pub snapshot_every: u64,
    /// The seq the log starts above (for resuming a persisted campaign). Default 0.
    pub start_seq: u64,
    /// Solo mode: run the full single-player turn loop (`start_turn` → action → mob reactions →
    /// `next_player`) around each time-advancing command, mirroring the TS `GameSession.execute`.
    /// The offline single-player host sets this; the multiplayer room server leaves it `false` (turn
    /// advancement and mob strikes are the GM's explicit `nextPlayer`/`mobAttack` there). Default
    /// `false`.
    pub solo: bool,
    /// Managed-turns mode (multiplayer): `start_turn` the active player at the start of each turn
    /// (`beginCampaign`, and after `nextPlayer`/`endTurn`) so the action budget resets and `onTurnStart`
    /// (dread) fires, and reject turn-actions once a player's `actionsPerRound` budget is spent. Turns
    /// are still ended explicitly — by the player (`endTurn`) or the GM (`nextPlayer`) — not
    /// auto-advanced. The room server sets this; the offline host (which uses `solo`) and the
    /// differential gate leave it `false` for byte-for-byte TS parity. Default `false`.
    pub manage_turns: bool,
}

impl Default for AuthorityOpts {
    fn default() -> Self {
        AuthorityOpts { snapshot_every: 20, start_seq: 0, solo: false, manage_turns: false }
    }
}

/// The single authority over a campaign's state: the live [`World`], the committed ordered log,
/// and the latest checkpoint.
pub struct SyncAuthority {
    world: World,
    catalog: Catalog,
    log: Vec<LogEntry>,
    checkpoint: (u64, CampaignSnapshot),
    snapshot_every: u64,
    start_seq: u64,
    solo: bool,
    manage_turns: bool,
    /// Solo-mode turn tracking: whether the active character's turn has begun (its `start_turn` — budget
    /// reset + affliction tick + `onTurnStart` — has fired). Cleared when the turn ends, so the next
    /// action starts a fresh turn. Only meaningful when `solo`.
    solo_turn_started: bool,
}

impl SyncAuthority {
    /// Builds an authority over `world` (the genesis) resolving commands against `catalog`.
    pub fn new(world: World, catalog: Catalog, opts: AuthorityOpts) -> Self {
        let checkpoint = (opts.start_seq, world.to_snapshot());
        SyncAuthority {
            world,
            catalog,
            log: Vec::new(),
            checkpoint,
            snapshot_every: opts.snapshot_every.max(1),
            start_seq: opts.start_seq,
            solo: opts.solo,
            manage_turns: opts.manage_turns,
            solo_turn_started: false,
        }
    }

    /// Highest committed seq (`start_seq` when the log is empty).
    pub fn head(&self) -> u64 {
        self.log.last().map_or(self.start_seq, |e| e.seq)
    }

    /// The latest checkpoint (the genesis until the first `snapshot_every` commit).
    pub fn load_snapshot(&self) -> &(u64, CampaignSnapshot) {
        &self.checkpoint
    }

    /// The current authoritative state as a snapshot. Used to seed replicas and, in the
    /// differential gate, to assert a delta-driven replica converges to the authority.
    pub fn snapshot(&self) -> CampaignSnapshot {
        self.world.to_snapshot()
    }

    /// Committed entries with `seq >= from_seq`, in order.
    pub fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        self.log.iter().filter(|e| e.seq >= from_seq).cloned().collect()
    }

    /// Authorize → apply (restoring the pre-image on a [`ProceduralViolation`]) → diff → commit.
    /// Returns the committed `{ seq, delta }` or a terminal denial; state is never left
    /// half-mutated.
    pub fn submit(&mut self, command: Command) -> SubmitResult {
        if let AuthResult::Denied(reason) = authorize(&self.world, &command) {
            return SubmitResult::Denied { reason };
        }

        // Managed-turns budget gate (multiplayer): a turn-action is refused once the active player has
        // spent its `actionsPerRound` budget. The player then ends its turn (`endTurn`) — or the GM
        // does (`nextPlayer`) — which `start_turn`s the next player and resets the budget.
        if self.manage_turns && command.is_budgeted_action() {
            if let Some(actor) = command.actor_id() {
                let spent = self
                    .world
                    .characters
                    .get(actor)
                    .map(|c| c.actions_this_round >= c.actions_per_round)
                    .unwrap_or(false);
                if spent {
                    return SubmitResult::Denied { reason: "You have no actions left this turn.".into() };
                }
            }
        }

        // Keep an exact pre-apply copy of the world (rng included) to roll back to on a
        // violation — a partially-applied-then-rejected command must leave nothing behind. A
        // direct clone is guaranteed faithful, where a snapshot round-trip need not be.
        let backup = self.world.clone();
        let before = self.world.to_snapshot();
        let cues = match apply_command(&mut self.world, &command, &self.catalog, self.solo, self.manage_turns, &mut self.solo_turn_started) {
            Ok(cues) => cues,
            Err(v) => {
                self.world = backup;
                return SubmitResult::Denied { reason: v.0 };
            }
        };

        let after = self.world.to_snapshot();
        let mut delta = diff(&before, &after);
        // Carry the command's presentation cues (e.g. campaign `Status` readouts) on the delta so
        // they reach clients — the delta model otherwise discards them.
        delta.cues = cues;
        let seq = self.head() + 1;
        self.log.push(LogEntry { seq, base_seq: seq - 1, command, delta: delta.clone() });
        if seq.is_multiple_of(self.snapshot_every) {
            self.checkpoint = (seq, after);
        }
        SubmitResult::Committed { seq, delta }
    }
}

/// Resolves an authorized command against the engine and returns its presentation cues (which
/// [`submit`] carries on the delta).
///
/// In `solo` mode a **time-advancing** command runs the single-player turn loop, respecting the
/// character's `actionsPerRound` budget: the turn begins with `start_turn` (budget reset + affliction
/// tick + `onTurnStart`, e.g. dread) on the actor's FIRST action, each action spends a budget slot,
/// and the turn ends — light-tied mob reactions → `next_player` (round advance + outcome) — only once
/// the budget is spent (or immediately on `wait`, a deliberate pass). So a player gets its full budget
/// of actions per turn rather than one. Free commands (talk/equip/unequip) and the whole multiplayer
/// path (`solo == false`) resolve the action alone — turn advancement and mob strikes are the GM's
/// explicit `nextPlayer`/`mobAttack` there. `turn_started` is the authority's per-turn latch.
fn apply_command(
    world: &mut World,
    command: &Command,
    cat: &Catalog,
    solo: bool,
    manage_turns: bool,
    turn_started: &mut bool,
) -> Result<Vec<PresentationCue>, ProceduralViolation> {
    let mut cues: Vec<PresentationCue> = Vec::new();
    // Managed-turns (multiplayer): a turn-changing command begins the new active player's turn —
    // `start_turn` resets their budget, ticks afflictions, and fires `onTurnStart` (dread).
    if manage_turns
        && matches!(command, Command::BeginCampaign | Command::NextPlayer | Command::EndTurn { .. })
    {
        apply_action(world, command, cat, &mut cues)?; // begin_campaign / next_player
        if let Ok(active) = world.active_character_id() {
            world.start_turn(&active, cat, &mut cues)?;
        }
        return Ok(cues);
    }
    if solo && command.is_time_advancing() {
        // The active character is the actor (authorize enforced it).
        let actor = world.active_character_id()?;
        // Begin the turn on the actor's first action: reset the budget, tick afflictions, fire the
        // onTurnStart hooks (dread). Subsequent actions in the same turn skip this.
        if !*turn_started {
            world.start_turn(&actor, cat, &mut cues)?;
            *turn_started = true;
        }
        apply_action(world, command, cat, &mut cues)?;
        // The turn ends when the action budget is spent, or immediately on a `wait` (a pass).
        let budget_spent = world
            .characters
            .get(&actor)
            .map(|c| c.actions_this_round >= c.actions_per_round)
            .unwrap_or(true);
        if budget_spent || matches!(command, Command::Wait { .. }) {
            // Light-tied initiative (movement.rs): ending the turn by moving INTO a LIT room gets the
            // drop — no mob reactions. Every other case (and moving into the dark) provokes.
            let entered_lit = matches!(command, Command::Move { .. })
                && world
                    .characters
                    .get(&actor)
                    .and_then(|c| c.current_room_id.clone())
                    .map(|rid| world.is_lit(&rid, cat))
                    .unwrap_or(false);
            if !entered_lit {
                let attacks = world.run_mob_reactions(&actor, cat, &mut cues);
                // Surface each strike as prose (the wire carries no `MobAttack` list); the HUD already
                // reflects the stat loss from the delta.
                for attack in &attacks {
                    cues.push(PresentationCue::Mechanic {
                        cue: MechanicCue { text: Some(attack.narration()), sound: None },
                    });
                }
            }
            world.next_player(cat, &mut cues)?;
            // The next actor's turn hasn't begun — it will `start_turn` on their first action.
            *turn_started = false;
        }
        return Ok(cues);
    }
    apply_action(world, command, cat, &mut cues)?;
    Ok(cues)
}

/// Dispatches an authorized command to the engine. Mirrors `resolver.ts` `apply` for the supported
/// subset; the engine resolves ids internally, so no separate entity index is needed. Fills `cues`
/// with what the action produced. Unsupported command kinds return a [`ProceduralViolation`] (the
/// caller turns it into a clean denial).
fn apply_action(
    world: &mut World,
    command: &Command,
    cat: &Catalog,
    cues: &mut Vec<PresentationCue>,
) -> Result<(), ProceduralViolation> {
    let result: Result<(), ProceduralViolation> = match command {
        Command::Move { actor_id, room_id } => world.move_to(actor_id, room_id.clone(), cat, cues),
        Command::Attack { actor_id, target_id } => world.attack(actor_id, target_id, cat, cues),
        Command::Equip { actor_id, item_id, .. } => world.equip(actor_id, item_id, cat, cues),
        Command::Unequip { actor_id, item_id } => world.unequip(actor_id, item_id, cat, cues),
        Command::Use { actor_id, item_id } => world.use_item(actor_id, item_id, cat, cues),
        // Free NPC dialogue: emits the selected entry's response + effects as cues on the delta.
        Command::Talk { actor_id, npc_id, prompt } => {
            world.talk(actor_id, npc_id, prompt.as_deref(), cat, cues)
        }
        // `wait` is a pure pass: the solo turn loop (start_turn → mob reactions → next_player) around
        // it carries the time cost; the action itself does nothing to the world.
        Command::Wait { .. } => Ok(()),
        Command::PickUp { actor_id, item_ids } => {
            for id in item_ids {
                world.take(actor_id, id, cat, cues)?;
            }
            Ok(())
        }
        Command::Drop { actor_id, item_ids } => {
            for id in item_ids {
                world.drop_item(actor_id, id, cat, cues)?;
            }
            Ok(())
        }
        Command::PutInLootBox { actor_id, loot_id, item_ids } => {
            world.put_in_loot_box(actor_id, loot_id, item_ids, cat, cues)
        }
        // A GM-issued mob strike is the actor-agnostic attack with a mob as the actor.
        Command::MobAttack { mob_id, target_id } => world.attack(mob_id, target_id, cat, cues),
        Command::MobEscape { mob_id } => world.mob_escape(mob_id, cat, cues),
        Command::SelectArchetype { actor_id, archetype_id } => {
            world.select_archetype(actor_id, archetype_id)
        }
        Command::TransferGm { character_id } => world.transfer_gm(character_id),
        Command::LeaveCampaign { character_id } => world.leave_campaign(character_id),
        Command::JoinCampaign { character } => world.join_campaign((**character).clone()),
        Command::BeginCampaign => world.begin_campaign(cat, cues),
        Command::EndCampaign => world.end_campaign(cues),
        Command::NextPlayer => world.next_player(cat, cues),
        // A player ending their own turn advances the active seat, exactly like the GM's nextPlayer.
        Command::EndTurn { .. } => world.next_player(cat, cues),
        // Materials & crafting — all FREE actions (turn-gated by `authorize`, no budget tick).
        Command::Harvest { actor_id, cache_id } => world.harvest(actor_id, cache_id, cat, cues),
        Command::Craft { actor_id, recipe_id } => {
            world.craft(actor_id, recipe_id, cat, cues).map(|_| ())
        }
        Command::Repair { actor_id, item_id } => world.repair(actor_id, item_id, cat, cues),
        // A1/A2 engine-action ports, join/seat handling (C), and the mob commands are not yet
        // wired — a clean denial, never a panic (the modding trust boundary).
        _ => Err(ProceduralViolation(
            "command kind not yet supported by the Rust sync port".into(),
        )),
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::{world_two_rooms, world_with_party};

    fn authority(world: World) -> SyncAuthority {
        SyncAuthority::new(world, Catalog::default(), AuthorityOpts::default())
    }

    #[test]
    fn commits_a_harvest_that_fills_the_pool() {
        // A free, turn-gated harvest wired through apply_action: the cache in the active pc's room
        // deposits into the shared pool and the committed delta reflects the change.
        use crate::world::ids::MaterialCacheId;
        use crate::world::snapshot::MaterialCacheSnapshot;
        let mut world = world_two_rooms(false); // pc active in the lit "start" room
        let cache_id = MaterialCacheId("cache:vein".into());
        world.material_caches.insert(
            cache_id.clone(),
            MaterialCacheSnapshot { id: cache_id.clone(), contents: serde_json::json!({ "iron": 2 }), depleted: false },
        );
        world.rooms.get_mut(&RoomId("start".into())).unwrap().material_cache_ids.push(cache_id.clone());
        let mut auth = authority(world);
        let res = auth.submit(Command::Harvest { actor_id: CharacterId("pc".into()), cache_id });
        assert!(matches!(res, SubmitResult::Committed { .. }), "harvest should commit, got {res:?}");
        assert_eq!(auth.snapshot().campaign.materials, serde_json::json!({ "iron": 2.0 }));
    }

    #[test]
    fn commits_a_craft_that_spends_from_the_pool() {
        // A known recipe crafted through the sync path: the output item lands in the pc's inventory
        // and the pool is debited — the whole materials→craft wire end to end.
        use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, RecipeMeta, SlotKind};
        let mut world = world_two_rooms(false);
        world.campaign.known_recipes.push("blade".into());
        world.campaign.materials = serde_json::json!({ "iron": 5 });
        let mut items = alloc::collections::BTreeMap::new();
        items.insert(
            "items/blade".to_string(),
            ItemDescriptor {
                name: "Iron Blade".into(),
                r#type: ItemType::Weapon,
                stat: crate::stats::StatType::Health,
                modifier: 2,
                properties: ItemProperties { equippable: true, equipped: false, destroyable: true, usable: false, droppable: None },
                slot: Some(SlotKind::Hand),
                two_handed: None,
                emits_light: None,
                max_durability: Some(4),
                lore: None,
                presentation: None,
                key_code: None,
                consume_on_use: None,
                recipe: serde_json::json!({ "iron": 2 }),
                teaches: serde_json::json!(null),
                immunities: serde_json::json!([]),
                grants_immunity: serde_json::json!(null),
            },
        );
        let mut recipes = alloc::collections::BTreeMap::new();
        recipes.insert(
            "blade".to_string(),
            RecipeMeta {
                id: "blade".into(),
                output_name: "Iron Blade".into(),
                materials: alloc::collections::BTreeMap::from([("iron".to_string(), 2)]),
                output_item_key: Some("items/blade".into()),
            },
        );
        let catalog = Catalog { items, recipes, ..Catalog::default() };
        let mut auth = SyncAuthority::new(world, catalog, AuthorityOpts::default());

        let res = auth.submit(Command::Craft { actor_id: CharacterId("pc".into()), recipe_id: "blade".into() });
        assert!(matches!(res, SubmitResult::Committed { .. }), "craft should commit, got {res:?}");
        let snap = auth.snapshot();
        assert_eq!(snap.campaign.materials, serde_json::json!({ "iron": 3.0 }), "pool debited by 2");
        let pc = snap.characters.iter().find(|c| c.id == CharacterId("pc".into())).expect("pc present");
        assert_eq!(pc.inventory.item_ids.len(), 1, "output held");
    }

    #[test]
    fn commits_a_move_and_produces_a_delta() {
        let mut auth = authority(world_two_rooms(false));
        let res = auth.submit(Command::Move {
            actor_id: CharacterId("pc".into()),
            room_id: RoomId("next".into()),
        });
        match res {
            SubmitResult::Committed { seq, delta } => {
                assert_eq!(seq, 1);
                // Moving the pc changes its character snapshot and the two rooms' occupants.
                assert!(delta.changed.iter().any(|e| matches!(e, super::super::delta::EntitySnapshot::Character(_))));
                assert!(!delta.changed.is_empty());
            }
            SubmitResult::Denied { reason } => panic!("expected commit, denied: {reason}"),
        }
        assert_eq!(auth.head(), 1);
        assert_eq!(auth.entries_since(1).len(), 1);
    }

    #[test]
    fn authorize_denial_does_not_advance_the_log() {
        let mut auth = authority(world_two_rooms(false));
        // "other" is not the active character → authorize rejects.
        let res = auth.submit(Command::Move {
            actor_id: CharacterId("other".into()),
            room_id: RoomId("next".into()),
        });
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(auth.head(), 0);
        assert!(auth.entries_since(1).is_empty());
    }

    #[test]
    fn violation_restores_the_pre_image_and_denies() {
        let mut auth = authority(world_two_rooms(false));
        let before = auth.world.to_snapshot();
        // Authorized (active pc, started, ongoing) but illegal: using an item the pc does not
        // hold throws a ProceduralViolation inside apply.
        let res = auth.submit(Command::Use {
            actor_id: CharacterId("pc".into()),
            item_id: crate::world::ids::ItemId("ghost-item".into()),
        });
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(auth.head(), 0, "a denied command commits nothing");
        assert_eq!(auth.world.to_snapshot(), before, "state must be fully restored");
    }

    #[test]
    fn unsupported_command_is_denied_not_panicked() {
        // craft is authorized as a turn-action but not yet wired → clean denial.
        let mut auth = authority(world_two_rooms(false));
        let res = auth.submit(Command::Craft {
            actor_id: CharacterId("pc".into()),
            recipe_id: "torch".into(),
        });
        assert!(matches!(res, SubmitResult::Denied { .. }));
        assert_eq!(auth.head(), 0);
    }

    #[test]
    fn sequencing_increments_and_entries_since_filters() {
        // A GM `nextPlayer` twice over a 2-player party: index 0 -> 1 -> 0 (end_round).
        let mut world = world_with_party(&["a", "b"], 10);
        world.campaign.gm_id = Some(CharacterId("a".into()));
        let mut auth = authority(world);
        assert!(matches!(auth.submit(Command::NextPlayer), SubmitResult::Committed { seq: 1, .. }));
        assert!(matches!(auth.submit(Command::NextPlayer), SubmitResult::Committed { seq: 2, .. }));
        assert_eq!(auth.head(), 2);
        assert_eq!(auth.entries_since(2).len(), 1, "entries_since(2) is just the second commit");
        assert_eq!(auth.entries_since(1).len(), 2);
    }

    /// Seed the always-registered `conformance:dread` mechanic so `start_turn` has an onTurnStart
    /// hook to fire ("The dread watches.").
    fn with_dread(mut world: World) -> World {
        world.campaign.mechanics.push(crate::world::snapshot::MechanicSnapshot {
            key: "conformance:dread".into(),
            state: serde_json::json!({ "ticks": 0 }),
        });
        world
    }

    fn solo_authority(world: World) -> SyncAuthority {
        SyncAuthority::new(world, Catalog::default(), AuthorityOpts { solo: true, ..Default::default() })
    }

    fn managed_authority(world: World) -> SyncAuthority {
        SyncAuthority::new(
            world,
            Catalog::default(),
            AuthorityOpts { manage_turns: true, ..Default::default() },
        )
    }

    #[test]
    fn managed_turns_refuse_actions_once_the_budget_is_spent() {
        // Multiplayer managed-turns: the active player's turn-actions are refused once
        // `actions_this_round` reaches `actions_per_round` — the seat must end its turn to act again.
        let mut world = world_two_rooms(false);
        if let Some(pc) = world.characters.get_mut(&CharacterId("pc".into())) {
            pc.actions_this_round = pc.actions_per_round;
        }
        let mut auth = managed_authority(world);
        let res = auth.submit(Command::Move {
            actor_id: CharacterId("pc".into()),
            room_id: RoomId("next".into()),
        });
        let SubmitResult::Denied { reason } = res else {
            panic!("a budget-spent move should be denied, got {res:?}");
        };
        assert!(reason.contains("no actions left"), "budget denial reason, got {reason:?}");
        assert_eq!(auth.head(), 0, "a denied command commits nothing");
    }

    #[test]
    fn managed_turns_allow_a_free_action_after_the_budget_is_spent() {
        // A spent budget bars a *budgeted* action but not a FREE one (equip/unequip/craft/repair/
        // harvest): unequipping an item the actor doesn't hold is still refused, but with the engine's
        // "not holding" violation — proving the budget gate let it through to apply rather than
        // pre-empting it with "no actions left".
        let mut world = world_two_rooms(false);
        if let Some(pc) = world.characters.get_mut(&CharacterId("pc".into())) {
            pc.actions_this_round = pc.actions_per_round;
        }
        let mut auth = managed_authority(world);
        let res = auth.submit(Command::Unequip {
            actor_id: CharacterId("pc".into()),
            item_id: crate::world::ids::ItemId("nope".into()),
        });
        let SubmitResult::Denied { reason } = res else {
            panic!("unequipping an unheld item should be denied, got {res:?}");
        };
        assert!(
            !reason.contains("no actions left"),
            "a free action must reach apply, not the budget gate; got {reason:?}"
        );
    }

    #[test]
    fn managed_turns_end_turn_advances_and_starts_the_next_turn() {
        // A player's `endTurn` advances the active seat (0 → 1) and `start_turn`s the next player,
        // firing their onTurnStart hook (dread) — the same machinery the GM's `nextPlayer` drives.
        let mut world = with_dread(world_with_party(&["a", "b"], 10));
        world.campaign.gm_id = Some(CharacterId("a".into()));
        let mut auth = managed_authority(world);
        let res = auth.submit(Command::EndTurn { actor_id: CharacterId("a".into()) });
        let SubmitResult::Committed { delta, .. } = res else {
            panic!("endTurn should commit, got {res:?}");
        };
        assert_eq!(
            auth.snapshot().campaign.active_character_index, 1,
            "endTurn advances to the next seat"
        );
        assert!(
            delta.cues.iter().any(|c| matches!(
                c,
                PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The dread watches.")
            )),
            "start_turn fires the next player's onTurnStart hook, got {:?}",
            delta.cues
        );
    }

    #[test]
    fn solo_wait_runs_the_full_turn_loop() {
        // Solo mode wraps a time-advancing command in start_turn → action → mob reactions →
        // next_player. A `wait` (a pure pass) therefore fires the onTurnStart hook (dread) and
        // advances the solo round — the single-player turn machinery the sync path otherwise skips.
        let mut world = with_dread(world_with_party(&["pc"], 10));
        world.campaign.gm_id = Some(CharacterId("pc".into()));
        let round_before = world.campaign.round;
        let mut auth = solo_authority(world);
        let res = auth.submit(Command::Wait { actor_id: CharacterId("pc".into()) });
        let SubmitResult::Committed { delta, .. } = res else {
            panic!("solo wait should commit, got {res:?}");
        };
        assert!(
            delta.cues.iter().any(|c| matches!(
                c,
                PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The dread watches.")
            )),
            "solo wait fires onTurnStart (dread), got {:?}",
            delta.cues
        );
        assert_eq!(auth.snapshot().campaign.round, round_before + 1, "solo wait advances the round");
    }

    #[test]
    fn a_non_solo_wait_is_a_pure_no_op() {
        // Without solo mode a `wait` resolves the (empty) action alone: no start_turn, no advance —
        // multiplayer leaves turn advancement to the GM's explicit `nextPlayer`.
        let mut world = with_dread(world_with_party(&["pc"], 10));
        world.campaign.gm_id = Some(CharacterId("pc".into()));
        let round_before = world.campaign.round;
        let mut auth = authority(world);
        let res = auth.submit(Command::Wait { actor_id: CharacterId("pc".into()) });
        let SubmitResult::Committed { delta, .. } = res else {
            panic!("wait should commit, got {res:?}");
        };
        assert!(delta.cues.is_empty(), "a non-solo wait fires no hooks, got {:?}", delta.cues);
        assert_eq!(auth.snapshot().campaign.round, round_before, "no solo loop → no round advance");
    }

    #[test]
    fn a_solo_time_advancing_action_provokes_co_located_mobs() {
        // A live mob sharing the actor's room strikes after a time-advancing action, and the strike
        // is surfaced as prose on the delta (the wire carries no MobAttack list).
        use crate::world::formations::conformance::seat_test_mob;
        let mut world = world_two_rooms(false); // pc in the lit "start" room
        seat_test_mob(&mut world, "Wraith", "start");
        world.campaign.gm_id = Some(CharacterId("pc".into()));
        let mut auth = solo_authority(world);
        // A `wait` is a non-move advancing action, so the light-tied drop-in immunity never applies —
        // the co-located mob provokes.
        let res = auth.submit(Command::Wait { actor_id: CharacterId("pc".into()) });
        let SubmitResult::Committed { delta, .. } = res else {
            panic!("solo wait should commit, got {res:?}");
        };
        assert!(
            delta.cues.iter().any(|c| matches!(
                c,
                PresentationCue::Mechanic { cue }
                    if cue.text.as_deref().is_some_and(|t| t.contains("Wraith"))
            )),
            "the mob's strike is narrated on the delta, got {:?}",
            delta.cues
        );
    }

    #[test]
    fn checkpoint_advances_on_the_snapshot_cadence() {
        let mut world = world_with_party(&["a", "b"], 100);
        world.campaign.gm_id = Some(CharacterId("a".into()));
        let mut auth = SyncAuthority::new(
            world,
            Catalog::default(),
            AuthorityOpts { snapshot_every: 2, start_seq: 0, solo: false, manage_turns: false },
        );
        assert_eq!(auth.load_snapshot().0, 0, "genesis checkpoint until the cadence");
        auth.submit(Command::NextPlayer); // seq 1
        assert_eq!(auth.load_snapshot().0, 0);
        auth.submit(Command::NextPlayer); // seq 2 -> checkpoint
        assert_eq!(auth.load_snapshot().0, 2);
    }
}
