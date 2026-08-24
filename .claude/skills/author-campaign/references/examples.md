# Example map — which shipped campaign demonstrates what

Every file lives in `campaigns/` and compiles clean; when generating a feature,
open the matching file and copy its shapes.

| Feature you need | Copy from |
|---|---|
| **A complete campaign** (rooms, keyed doors, npc, mobs, loot, scenes, mechanics, victory, darkness) | `hollow-house.toml` — the shipped nine-room game; the best overall reference |
| Multiplayer co-op victory (two players in two places at once) | `covenant.toml` |
| Minimal room/exit/keyed-door skeleton | `g2-vault.toml` |
| Archetypes (`baseStats`, `inventorySlots`, `immunities`) | `g2-archetype.toml` |
| Dark rooms + `lights` + a light-emitting item | `g2-dark-rooms.toml` |
| Stateful doors (`initialState`, `runScript`, `pass`) | `g2-door.toml`, `g2-exit-state.toml` |
| Items of every type, equipment `slot`s, durability, lore | `g2-item.toml`, `g2-equipment.toml` |
| Consumables with `onUse` effects | `g2-effects.toml` |
| Loot, caches, recipes (crafting) | `g2-item.toml` |
| Placed mobs (`stats`, `drops`, `naturalAttack`) | `g2-mobs.toml` |
| Random encounters (`[[formations]]`, weights, MobSpec shape) | `g2-formations.toml` |
| NPC dialogue (exact + fuzzy match, `once`, `effects` hand-over) | `g2-npc.toml` |
| Scenes (`phase`, `canPlay`, `onEnter` state latches) | `g2-scene.toml` |
| Mechanics: hooks, `init` state, `config` | `g2-mechanic.toml` |
| Mechanic custom `actions` | `g2-mechanic-actions.toml` |
| `modifyDamage` transforms | `g2-mechanic.toml` |
| HUD `status(...)` readouts | `g2-status-bar.toml` |
| Per-room narration state maps (`stateGetIn`, `set state.m[k]`, `mapLit`) | `g2-storyteller.toml` |
| Victory/lose conditions | `g2-victory.toml` |
| Round timeout + `timeoutNarration` | `g2-timeout.toml` |
| The Villain + Wicked Ways cards (`[villain]`, `[[cards]]`, `onPlay`) | `g2-villain.toml` |
| Campaign `[opts]` | `g2-opts.toml` |
