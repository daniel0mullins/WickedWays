---
name: author-campaign
description: Turn a plain-language campaign idea into a valid WickedWays campaign TOML in campaigns/. Use when someone wants to create, write, design, or mod a campaign, scenario, dungeon, adventure, or haunted house — e.g. "make a campaign where…", "I want a scenario with a locked crypt", "add a new adventure".
---

# Author a WickedWays campaign from plain language

You are turning a modder's description into a campaign TOML file that the real
compiler accepts. The format is **strict** (`deny_unknown_fields` — one stray or
misspelled key is a hard error) and every name is a **cross-reference** (an exit's
`from` must be a room's `name`, an item in `loot` must be an `[[items]]` key, …), so
work from the references in this skill, never from memory.

## Read these first

1. `references/format.md` — every TOML table and field, exactly as the compiler
   accepts them.
2. `references/dsl.md` — the behavior DSL for doors, scenes, mechanics, items,
   victory tests.
3. `references/examples.md` — which shipped file in `campaigns/` demonstrates each
   feature. When generating a feature, **open the matching example and copy its
   shapes** — they are compiler-verified ground truth.

## Workflow

1. **Fill the gaps in the idea.** A playable campaign needs at minimum: a title, 2+
   rooms, a `startRoom`, exits connecting the rooms (remember return legs — exits
   are one-directional entries), and at least one `[[victory.win]]` condition so the
   game can end. If the description leaves these open, pick sensible genre-fitting
   defaults and say what you chose — don't stall on questions unless the idea is
   genuinely ambiguous. Horror flavor is the house style: dread, darkness, a
   reluctant house.

2. **Map the idea onto asset families** (see `format.md` for each):
   - places → `[[rooms]]` (+ `dark = true` rooms and `lights` for the darkness
     mechanic), `[[exits]]`
   - locked doors / one-way passages → exit `behavior` + `[behaviors.exit.<key>]`
     + a `keyCode` item
   - things to find → `[[items]]` + `[[loot]]` (loot places items in rooms)
   - enemies → `[[mobs]]` (placed) or `[[formations]]` (random encounters)
   - people to talk to → `[[npcs]]` + `[behaviors.npc.<key>]` dialogue
   - moments/narration on entering a room → `[[scenes]]` + `[behaviors.scene.<key>]`
   - campaign-wide rules (sanity drain, damage caps, HUD) → `[[mechanics]]` +
     `[behaviors.mechanic.<key>]`
   - an antagonist playing cards against the party → `[villain]` + `[[cards]]`
   - how to win / lose → `[[victory.win]]` / `[[victory.lose]]`

3. **Write the file** to `campaigns/<kebab-case-title>.toml`. Order tables the way
   the shipped campaigns do (settings → archetypes → rooms → exits → items → loot →
   npcs/mobs → scenes → mechanics → victory → behaviors). Double-check every
   cross-reference as you go.

4. **Validate with the real compiler** — this is mandatory, never skip it:

   ```bash
   cargo run -p wickedways-author --bin wwauthor -- campaigns/<name>.toml
   ```

   It reports **all** errors at once, each labeled with the TOML path of the body it
   came from. Fix and re-run until it exits cleanly (it writes
   `<name>.description.json` + `<name>.catalog.json` next to the TOML on success —
   delete those artifacts afterwards unless the modder wants them; only the TOML
   belongs in `campaigns/`).

5. **Sanity-check playability**, not just compilability: is every room reachable
   from `startRoom`? Does every locked door's key exist in reachable loot? Can the
   win condition actually be met? Walk the critical path in your head and fix
   dead-ends.

6. **Offer the playtest.** The modder can try the campaign immediately: open
   Campaign Studio (`/studio` on a deployed instance, or `dx serve` in
   `crates/wickedways-studio`), import the TOML (paste or file picker), hit
   **Check campaign**, then **▶ Playtest** on the green gate.

## Rules

- Never invent a field, effect, function, or stat name that isn't in the
  references. If the idea needs something the format can't express, say so and
  offer the closest expressible design.
- Stats are exactly `health`, `sanity`, `energy`. Directions are the eight compass
  words. Scene phases are `enter`/`exit`.
- New campaigns in `campaigns/` are NOT part of the golden test corpus — do not add
  gate entries or regenerate goldens for them.
- Keep authored prose atmospheric but concise; room descriptions of one to three
  sentences match the house style.
