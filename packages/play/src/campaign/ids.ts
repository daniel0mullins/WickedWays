export const Rooms = {
  Foyer: "Foyer", Cellar: "Cellar", Hall: "Hall", Kitchen: "Kitchen",
  Parlor: "Parlor", Landing: "Landing", Study: "Study", Nursery: "Nursery", Attic: "Attic",
} as const;

export const Items = {
  Lantern: "lantern", Journal: "journal", Poker: "poker", Laudanum: "laudanum",
} as const;

export const Keys = { Brass: "brass-key", Iron: "iron-key" } as const;

export const Mobs = { Wraith: "Wraith", Revenant: "Revenant" } as const;

export const Mechanics = { Dread: "dread", Storyteller: "storyteller" } as const;

export const Archetypes = { Heir: "heir" } as const;

export const Conditions = {
  ReachedAtticWithJournal: "reached-attic-with-journal",
  SanityZero: "sanity-zero",
  PartyDown: "party-down",
} as const;
