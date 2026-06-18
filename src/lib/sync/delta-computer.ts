import type { CampaignSnapshot } from "../serialization/types";
import type { Delta, EntitySnapshot } from "./types";

type Tagged = EntitySnapshot["type"];

/** Diffs two full campaign snapshots into a minimal entity-delta. */
export class DeltaComputer {
  /**
   * Compares every entity collection between `before` and `after` and returns a
   * {@link Delta} classifying each entity as changed, created, or removed.
   * Campaign core and codex are included when they differ.
   */
  diff(before: CampaignSnapshot, after: CampaignSnapshot): Delta {
    const changed: EntitySnapshot[] = [];
    const created: EntitySnapshot[] = [];
    const removed: string[] = [];

    this.diffArray("room", before.rooms, after.rooms, changed, created, removed);
    this.diffArray("character", before.characters, after.characters, changed, created, removed);
    this.diffArray("item", before.items, after.items, changed, created, removed);
    this.diffArray("loot", before.loot, after.loot, changed, created, removed);
    this.diffArray("materialCache", before.materialCaches, after.materialCaches, changed, created, removed);

    const coreChanged =
      JSON.stringify(before.campaign) !== JSON.stringify(after.campaign) ||
      JSON.stringify(before.codex) !== JSON.stringify(after.codex);

    const delta: Delta = { changed, created, removed };
    if (coreChanged) {
      delta.campaignCore = { core: after.campaign, codex: after.codex };
    }
    return delta;
  }

  private diffArray<T extends { id: string }>(
    type: Tagged,
    before: T[],
    after: T[],
    changed: EntitySnapshot[],
    created: EntitySnapshot[],
    removed: string[],
  ): void {
    const beforeById = new Map(before.map((e) => [e.id, e]));
    const afterById = new Map(after.map((e) => [e.id, e]));

    for (const [id, a] of afterById) {
      const b = beforeById.get(id);
      if (b === undefined) {
        created.push({ type, data: a } as unknown as EntitySnapshot);
      } else if (JSON.stringify(b) !== JSON.stringify(a)) {
        changed.push({ type, data: a } as unknown as EntitySnapshot);
      }
    }
    for (const id of beforeById.keys()) {
      if (!afterById.has(id)) removed.push(id);
    }
  }
}
