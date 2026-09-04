# Pending changesets

Each `*.md` file here (this README excepted) is one **changeset**: a not-yet-released change,
carrying the [semver](https://semver.org) bump it calls for and the prose that will become its
CHANGELOG entry. The next `cargo xtask release` consumes them all — the largest bump decides the
next version — and deletes the files.

Record one per user-visible change:

```bash
cargo xtask add minor "Exits now replicate through the sync delta."
cargo xtask status   # pending changesets + the version they add up to
```

or write the file by hand:

```markdown
---
bump: patch
---

Fixed the cellar door refusing its own key.
```

- `bump:` is `major` (breaking — saves, goldens, or the wire protocol stop being compatible),
  `minor` (new campaign-visible or modder-visible capability), or `patch` (a fix).
- The body is the CHANGELOG entry, verbatim — write it for players and modders, not committers.
  Extra lines are kept, indented under the bullet.
- CI (`changeset.yml`) requires a changeset on any PR that touches shipped code; purely internal
  PRs can be exempted with the `no-changeset` label.
