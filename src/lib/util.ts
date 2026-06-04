import { Brand } from "./brand";
import { v4 as uuid } from "uuid";
import { LootId } from "./loot";

export type BaseId = Brand<string, "Id">;

export function generateId<T extends Brand<string, string>>() {
  return uuid() as T;
}

export type Entries<T> = {
  [K in keyof T]: [K, T[K]];
}[keyof T][];
export function typedEntries<T extends object>(obj: T): Entries<T> {
  return Object.entries(obj) as Entries<T>;
}

export class ProceduralViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProceduralViolation";
  }
}

export class ContainerFullException extends Error {
  constructor(containerId: LootId) {
    super(`Container ${containerId} is full`);
    this.name = "ContainerFullException";
  }
}
