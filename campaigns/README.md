# Campaigns

The authored campaign sources — every campaign is one TOML file in the
campaign-author format compiled by `wickedways-author`. **This is the directory to
start from if you want to write or modify a campaign.**

Three ways to work with these files:

- **Campaign Studio** (served at `/studio` on a deployed instance, or
  `dx serve` in `crates/wickedways-studio`): the graphical editor. Every file
  here is available in the studio as a template ("New from …" and the template
  gallery), and the studio imports/exports this exact TOML format.
- **By hand + the compiler**: edit the TOML, then validate with
  `cargo run -p wickedways-author --bin wwauthor -- campaigns/<name>.toml` — it
  reports every compile finding at once, labeled by TOML path. The format is
  documented by example — `hollow-house.toml` is the complete shipped campaign.
- **Describe it to Claude Code**: the repo ships the `author-campaign` skill
  (`.claude/skills/author-campaign/`) — tell Claude the campaign you want in plain
  language ("a lighthouse where the keeper's ghost guards the lamp-room key…") and
  it generates, validates, and iterates the TOML here for you.

## What's here

| File | What it is |
|---|---|
| `hollow-house.toml` | **The Hollow House** — the shipped nine-room campaign; the fullest example of the format. |
| `covenant.toml` | **The Covenant** — the co-op multiplayer campaign (twin-ward victory needs two players). |
| `solomons-rest.toml` | **The Dare at Solomon's Rest** — the cemetery survival **multiplayer** campaign: teens self-join against the GM, who plays the Sexton (the `"@gm"` Villain). A procedurally generated map (`[mapGen]`), a world-scoped daybreak clock (`worldGet`/`setWorld`), and a party-splitting deck that exploits the Sexton's only-when-alone compact. The reference for all three features. |
| `g2-*.toml` | Single-feature campaigns, one per engine mechanic (doors, mobs, scenes, victory, villain cards, …). Small, focused references for how each feature is authored — and the studio's template gallery. |

## Campaign art (`assets/`)

Any archetype, room, item, mob, NPC, or card entry may carry
`image = "<relative path>.webp"` — a path into `campaigns/assets/` (see its
README for conventions and the path rules). The compiler validates the path
shape and records the **association only**: rooms/mobs/npcs/archetypes/cards
land in `catalog.images` keyed by their entity id (`room:{name}`,
`mob:{name}`, `npc:{name}`, `archetype:{id}`, `card:{key}`); items land in
their descriptor's `presentation.image`. The image **files** never enter the
TOML, the goldens, or engine state — the room server serves them statically
under `/assets/`, and the surfaces resolve the paths at render time.
`g2-images.toml` is the focused reference.

## Relationship to `conformance/fixtures/`

The golden corpus under `conformance/fixtures/` holds the **compiled output** of
these sources (description/catalog/genesis JSON) plus engine replay goldens —
regression pins, not sources. The gates compile the TOML here and hold the
result equal to those pins; regenerate them deliberately with
`UPDATE_GOLDENS=1` (see the root `CLAUDE.md`). Never edit the goldens by hand —
edit the TOML here and regenerate.
