---
layout: home
hero:
  name: Wicked Ways
  text: A type-safe tabletop RPG engine
  tagline: Turn-based horror campaigns modeled in TypeScript — branded IDs, hidden state, and runtime lifecycle guards.
  image:
    src: /logo.png
    alt: Wicked Ways
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
features:
  - title: Type-safe by construction
    details: Branded IDs and hidden state make illegal game states hard to represent at compile time.
  - title: Runtime lifecycle guards
    details: Illegal moves throw ProceduralViolation instead of silently corrupting campaign state.
  - title: Deterministic & testable
    details: All randomness flows through an injected rng, so seeded runs are fully reproducible.
---
