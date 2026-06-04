export const StatType = {
  Energy: "energy",
  Sanity: "sanity",
  Health: "health",
} as const;

export const MitigatorStatType = {
  [StatType.Energy]: StatType.Health,
  [StatType.Health]: StatType.Sanity,
  [StatType.Sanity]: StatType.Energy,
} as const;

export type StatType = (typeof StatType)[keyof typeof StatType];
export type Stats = {
  [StatType.Energy]: number;
  [StatType.Sanity]: number;
  [StatType.Health]: number;
};
