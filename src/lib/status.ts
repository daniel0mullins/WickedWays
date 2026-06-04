export const Status = {
  KO: "ko",
  Panic: "panic",
  Confused: "confused",
  Fear: "fear",
} as const;
export type Status = (typeof Status)[keyof typeof Status];
export type StatusMatrix = Map<Status, boolean>;
