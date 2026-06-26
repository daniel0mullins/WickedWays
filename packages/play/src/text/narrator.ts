import type { PresentationCue } from "wickedways/lib/presentation";
import { StatType } from "wickedways/lib/character/stats";
import type { ViewModel, ScopeEntity } from "../core/viewmodel.js";
import type { Intent } from "../core/intent.js";
import type { MobAttack } from "../core/session.js";

const sentence = (items: string[], head: string): string | null =>
  items.length === 0 ? null : `${head} ${items.join(", ")}.`;

export interface RoomParts {
  header: string;
  description: string | null;
  body: string[];
  /** True the first time a room is described this session — only affects pacing
   *  (the description prints on every visit). */
  firstVisit: boolean;
}

export class Narrator {
  private readonly visited = new Set<string>();

  renderRoomParts(vm: ViewModel): RoomParts {
    const header = vm.room.name;
    const firstVisit = !this.visited.has(vm.room.id);
    this.visited.add(vm.room.id);
    // The room description prints on every visit (firstVisit only paces the typing).
    const description = vm.room.description;

    const body: string[] = [];
    if (!vm.room.isLit) {
      body.push("It is pitch dark. You can see nothing.");
      return { header, description, body, firstVisit };
    }

    // Loot ("Here: …") and exits ("Exits: …") now live in the persistent bottom
    // HUD (rendered by ui.ts from the viewmodel), not in the scrolling transcript.
    // Only occupants stay in the transcript body.
    // Defeated mobs linger in the room (KO is a downed status, not removal) but
    // are no longer "present" to the player — list only the living.
    const occ = sentence(vm.occupants.filter((o) => !o.defeated).map((o) => o.name), "You see");
    if (occ) body.push(occ);

    return { header, description, body, firstVisit };
  }

  renderRoom(vm: ViewModel): string[] {
    const { header, description, body } = this.renderRoomParts(vm);
    const lines: string[] = [header];
    if (description !== null) lines.push(description);
    lines.push(...body);
    return lines;
  }

  renderCues(cues: PresentationCue[]): string[] {
    const lines: string[] = [];
    for (const cue of cues) {
      switch (cue.kind) {
        case "mechanic": if (cue.cue.text) lines.push(cue.cue.text); break;
        case "encounter": lines.push(`A ${cue.mob.name} is here.`); break;
        case "visibility": lines.push(cue.lit ? "Light spills into the room." : "Darkness closes in."); break;
        case "resolution": if (cue.narration?.text) lines.push("", cue.narration.text); break;
        case "action": break; // movement/attack already implied by room re-render; keep terse
      }
    }
    return lines;
  }

  renderQuery(query: "look" | "inventory" | "exits" | "help", vm: ViewModel): string[] {
    switch (query) {
      case "look": return this.renderRoom(vm);
      case "inventory": {
        const names = [...vm.inventory.items.map((i) => i.name), ...vm.inventory.keys.map((k) => k.name)];
        return names.length ? [`You are carrying: ${names.join(", ")}.`] : ["You are carrying nothing."];
      }
      case "exits": {
        const ways = [...vm.exits.map((e) => `${e.dir} to the ${e.toName}`), ...vm.lockedDoors.map((d) => `${d.dir} (the ${d.name}, locked)`)];
        return ways.length ? [`Exits: ${ways.join(", ")}.`] : ["There are no obvious exits."];
      }
      case "help":
        return ["Commands: go <dir> (or n/s/e/w/…) — walk into a locked door with its key to open it, look, examine/read <thing>, take/drop <thing>, open <chest>, equip/use <thing>, attack <foe>, inventory, exits, wait, save, restore, undo, restart, fullscreen, audio, map."];
    }
  }

  renderExamine(target: ScopeEntity, _vm: ViewModel): string[] {
    // Loot containers carry their full description as `name` (e.g. "A hall table
    // with a single drawer."), so strip a leading article and trailing period
    // before the "the …" frame to avoid "the A hall table…..". Bare item/occupant
    // names have neither, so this is a no-op for them.
    const noun = target.name.replace(/^(a|an|the)\s+/i, "").replace(/\.\s*$/, "");
    return [`You look closely at the ${noun}. Nothing more reveals itself — yet.`];
  }

  /**
   * Confirmation line(s) for a state-changing action. The engine emits only a
   * terse `action` cue (kind + actor, no item name), so feedback for
   * take/drop/open/equip/use is synthesized here from the parsed intent and the
   * before/after viewmodels. `move` and `attack` return nothing — the room
   * re-render and combat cues already speak for them.
   */
  renderAction(intent: Intent, before: ViewModel, after: ViewModel): string[] {
    // Resolve a target's display name from either view's scope. `before` covers
    // take/drop/equip (item still visible beforehand); `after` covers unequip
    // (the item only re-enters inventory scope once unequipped).
    const nameOf = (id: string): string => {
      for (const v of [before, after]) {
        const hit = v.scope.find((e) => e.id === id);
        if (hit) return hit.name;
      }
      return "it";
    };

    switch (intent.kind) {
      case "take": return [`You take the ${nameOf(intent.targetId)}.`];
      case "drop": return [`You set down the ${nameOf(intent.targetId)}.`];
      case "equip": return [`You ready the ${nameOf(intent.targetId)}.`];
      case "unequip": return [`You put away the ${nameOf(intent.targetId)}.`];
      case "use": return [`You use the ${nameOf(intent.targetId)}.`];
      case "open": {
        const box = before.loot.find((l) => l.id === intent.targetId)
          ?? after.loot.find((l) => l.id === intent.targetId);
        const contents = box?.contents.map((c) => c.name) ?? [];
        return contents.length
          ? [`You open it. Inside: ${contents.join(", ")}.`]
          : ["You open it. It is empty."];
      }
      case "wait": return ["You wait. The house holds its breath."];
      case "attack": {
        const target = before.occupants.find((o) => o.id === intent.targetId);
        const result = after.occupants.find((o) => o.id === intent.targetId);
        const name = target?.name ?? result?.name ?? "it";
        if (result?.defeated && !target?.defeated) {
          return [`You strike the ${name} down. It leaves its remains behind.`];
        }
        const damage = (target?.health ?? 0) - (result?.health ?? 0);
        return damage > 0
          ? [`You hit the ${name} for ${damage} Health.`]
          : [`Your blow glances off the ${name}.`];
      }
      case "move":
      case "talk":
        return [];
    }
  }

  /**
   * Renders incoming mob strikes, each naming the stat lost so the player sees
   * what kind of harm landed (Sanity vs Health vs Energy).
   */
  renderMobAttacks(attacks: MobAttack[]): string[] {
    return attacks.map((a) => {
      switch (a.stat) {
        case StatType.Sanity: return `The ${a.name} claws at your mind — you lose ${a.amount} Sanity.`;
        case StatType.Energy: return `The ${a.name} saps your strength — you lose ${a.amount} Energy.`;
        case StatType.Health:
        default: return `The ${a.name} tears into you — you lose ${a.amount} Health.`;
      }
    });
  }
}
