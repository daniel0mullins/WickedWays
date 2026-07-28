---
layout: home
hero:
  name: Wicked Ways
  text: A tabletop horror-RPG engine in Rust
  tagline: Turn-based horror campaigns — branded IDs, lifecycle guards, and a wasm web client.
  image:
    src: /logo.png
    alt: Wicked Ways
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /guide/architecture
features:
  - title: Type-safe by construction
    details: Branded IDs and private state make illegal game states hard to represent at compile time.
  - title: Runtime lifecycle guards
    details: Illegal moves throw ProceduralViolation instead of silently corrupting campaign state.
  - title: Deterministic & testable
    details: All randomness flows through the seeded world RNG, so replays are fully reproducible and pinned by golden gates.
---
