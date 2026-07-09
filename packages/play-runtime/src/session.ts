import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { ArchetypeId } from "wickedways/lib/archetype";
import { engine } from "#engine";
import type { Authority } from "./engine-types.js";
import { catalogFromRegistry } from "./catalog.js";
import { isTimeAdvancing, type Intent } from "./intent.js";
import type { ViewModel } from "./viewmodel.js";
import type { SaveStore, SurfaceState } from "./savestore.js";
import type { BehaviorScript } from "../../../generated/bindings/BehaviorScript.ts";
import type { FormationDescriptor } from "../../../generated/bindings/FormationDescriptor.ts";

// `MobAttack` mirrors the generated core binding (single source of truth,
// invariant 1); it is structurally identical to the pre-cutover shape.
export type { MobAttack } from "../../../generated/bindings/MobAttack.ts";
import type { MobAttack } from "../../../generated/bindings/MobAttack.ts";

/**
 * The result of an {@link GameSession.execute}. Held at its exact pre-cutover
 * public shape so host surfaces (audio/narrator consume the engine's TS
 * {@link PresentationCue}) keep compiling. Runtime-identical to the generated
 * `ExecuteResult` (conformance-verified byte parity) — the JSON the Authority
 * returns is parsed straight into this shape.
 */
export interface ExecuteResult { cues: PresentationCue[]; mobAttacks?: MobAttack[]; error?: string; }

export interface SessionOptions {
  builder: TemplateBuilder<string, string>;
  registry: CampaignRegistry;
  aliases: Record<string, string[]>;
  /** Campaign's scripted behaviors (from the CampaignManifest); threaded into
   *  the Rust Catalog so `Authority::new`→`validate_mechanics` can resolve every
   *  registered mechanic/exit/victory key. `{}` for behavior-less campaigns. */
  behaviors?: Record<string, BehaviorScript>;
  /** Campaign's data-driven encounter formations (from the CampaignManifest),
   *  keyed by encounter `behaviorKey`; threaded into the Rust Catalog so
   *  `World::maybe_spawn` can resolve descriptor formations. `{}` for campaigns
   *  with no data-driven formations. */
  formations?: Record<string, FormationDescriptor>;
  playerName: string;
  archetype?: string;
  saveStore: SaveStore;
  now: () => number;          // injected clock (no ambient Date.now)
  /** Authority rng seed; a fresh random seed per session when omitted. */
  seed?: number;
}

export class GameSession {
  #authority!: Authority;
  /** Host-side presentation overlay (invariant 6): captured at boot from the
   *  assembled TS campaign — presentation is never serialized, so the core
   *  cannot emit it. Mobs spawned post-boot have no image (as after a TS
   *  restore today). */
  readonly #roomImages = new Map<string, string>();
  readonly #occupantImages = new Map<string, string>();
  private undoSnapshot: string | null = null;

  private constructor(private readonly opts: SessionOptions) {}

  static start(opts: SessionOptions): GameSession {
    const s = new GameSession(opts);
    s.boot(opts.builder);
    return s;
  }

  private boot(builder: TemplateBuilder<string, string>): void {
    // TS authoring stays: assemble + PC setup produce the PRE-begin genesis.
    const { campaign, rooms } = assemble(builder.description, builder.registry);
    const pc = new PlayerCharacter({ campaign, name: this.opts.playerName });
    pc.joinCampaign();
    if (this.opts.archetype !== undefined) {
      pc.selectArchetype(this.opts.archetype as ArchetypeId);
    }
    // Pristine-genesis boot placement: seat the PC in the start room WITHOUT
    // firing enter-scenes (`fireScenes = false`). The start-room enter-scenes are
    // deferred to the Authority's `begin_campaign` (Rust), which fires them into
    // the startup-cue buffer AFTER the round-0 dispatch — the order is pinned
    // identically in Rust `begin_campaign`, TS `Campaign.beginCampaign`, and the
    // oracle-session begin/startup, for differential-gate parity.
    pc.move(rooms.get(builder.description.startRoom!)!, /*fireScenes*/ false);
    campaign.gm = pc;

    // Presentation overlay capture (rooms + boot-time occupants, by id).
    this.#roomImages.clear();
    this.#occupantImages.clear();
    for (const room of rooms.values()) {
      const img = room.presentation?.image;
      if (img !== undefined) this.#roomImages.set(room.id, img);
      for (const occ of room.occupants) {
        const oimg = occ.presentation?.image;
        if (oimg !== undefined) this.#occupantImages.set(occ.id, oimg);
      }
    }

    // Core-begins lifecycle: serialize BEFORE beginCampaign; the Authority runs
    // begin_campaign itself and buffers the round-0 cues.
    const genesis = JSON.stringify(serializeCampaign(campaign));
    // POST-DSL: thread the campaign's scripted behaviors so validate_mechanics passes
    // (see the catalogFromRegistry reconciliation note). `{}` for behavior-less test campaigns.
    const catalog = JSON.stringify(
      catalogFromRegistry(
        this.opts.registry,
        this.opts.aliases,
        this.opts.behaviors ?? {},
        this.opts.formations ?? {},
      ),
      // Formation descriptors carry `i64` fields as `bigint` (baseEscapeChance,
      // actionsPerRound); JSON.stringify throws on bigint. Coerce to Number so
      // serde reads them as JSON integers — mirrors the conformance fixture's
      // bigintReplacer, so the live catalog matches the golden byte-for-byte.
      (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v),
    );
    const seed = this.opts.seed ?? (Math.random() * 0x1_0000_0000) >>> 0;
    this.#authority?.free();
    this.#authority = new (engine().Authority)(genesis, catalog, seed);
  }

  takeStartupCues(): PresentationCue[] {
    return JSON.parse(this.#authority.takeStartupCues()) as PresentationCue[];
  }

  restart(): void {
    this.undoSnapshot = null;
    this.boot(this.opts.builder);
  }

  view(): ViewModel {
    const vm = JSON.parse(this.#authority.view()) as ViewModel;
    const roomImage = this.#roomImages.get(vm.room.id);
    if (roomImage !== undefined) vm.room.image = roomImage;
    for (const list of [vm.occupants, vm.scope]) {
      for (const e of list) {
        const img = this.#occupantImages.get(e.id);
        if (img !== undefined) e.image = img;
      }
    }
    return vm;
  }

  read(itemId: string): PresentationCue[] {
    return JSON.parse(this.#authority.read(itemId)) as PresentationCue[];
  }

  /** Free, non-time-advancing examine of a co-located, visible NPC: the engine
   *  emits the NPC's `description` blurb (empty for any non-NPC / hidden /
   *  not-co-located target). Mirrors {@link read} for the NPC-examine path. */
  examine(targetId: string): PresentationCue[] {
    return JSON.parse(this.#authority.examine(targetId)) as PresentationCue[];
  }

  get finished(): boolean { return this.#authority.finished; }
  get outcome(): string { return this.#authority.outcome; }

  execute(intent: Intent): ExecuteResult {
    const advances = isTimeAdvancing(intent);
    const pre = advances ? this.#authority.snapshot() : null;
    const result = JSON.parse(this.#authority.submit(JSON.stringify(intent))) as ExecuteResult;
    // TS semantics: the undo stash updates only on a SUCCESSFUL advancing action.
    if (advances && result.error === undefined && pre !== null) this.undoSnapshot = pre;
    return result;
  }

  async save(slot: string, surface?: SurfaceState): Promise<void> {
    const snapshot = JSON.parse(this.#authority.snapshot()) as CampaignSnapshot;
    await this.opts.saveStore.save(slot, snapshot, this.opts.now(), surface);
  }

  async restore(slot: string): Promise<{ ok: boolean; surface?: SurfaceState }> {
    const loaded = await this.opts.saveStore.load(slot);
    if (!loaded) return { ok: false };
    this.#authority.restore(JSON.stringify(loaded.snapshot));
    return { ok: true, surface: loaded.surface };
  }

  undo(): boolean {
    if (!this.undoSnapshot) return false;
    this.#authority.restore(this.undoSnapshot);
    this.undoSnapshot = null;
    return true;
  }
}
