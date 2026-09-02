# Campaign art

Image files referenced by the `image = "…"` fields in the campaign TOML
(`campaigns/*.toml`). An `image` value is a plain relative path resolved
against THIS directory — `image = "rooms/foyer.webp"` means
`campaigns/assets/rooms/foyer.webp` — and served by the room server under
`/assets/` (the `ASSETS_DIR` env var; the Docker image copies this directory
there).

Conventions:

- Namespace by campaign when art isn't shared:
  `hollow-house/rooms/foyer.webp`, referenced as
  `image = "hollow-house/rooms/foyer.webp"`.
- Paths are validated at compile time: relative only — no leading `/`, no
  `..` or `.` segments, no `\`, no `:`. Never inline base64/data URIs in the
  TOML; images stay files here so snapshots, sync deltas, and the golden
  corpus never carry image bytes.
- Prefer `.webp` for size; any browser-renderable format works — the engine
  never opens the files, it only carries the path strings
  (`catalog.images` / item `presentation.image`).
