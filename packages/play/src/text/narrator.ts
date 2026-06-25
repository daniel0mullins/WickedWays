import type { PresentationCue } from "wickedways/lib/presentation";
import type { ViewModel, ScopeEntity } from "../core/viewmodel.js";

const sentence = (items: string[], head: string): string | null =>
  items.length === 0 ? null : `${head} ${items.join(", ")}.`;

export class Narrator {
  private readonly visited = new Set<string>();

  renderRoom(vm: ViewModel): string[] {
    const lines: string[] = [`*${vm.room.name}*`];
    const firstVisit = !this.visited.has(vm.room.id);
    this.visited.add(vm.room.id);
    if (firstVisit) lines.push(vm.room.description);
    if (!vm.room.isLit) { lines.push("It is pitch dark. You can see nothing."); return lines; }

    const occ = sentence(vm.occupants.map((o) => o.name), "You see");
    if (occ) lines.push(occ);
    const loot = sentence(vm.loot.map((l) => l.description), "Here:");
    if (loot) lines.push(loot);
    const exits = vm.exits.map((e) => e.dir);
    const locked = vm.lockedDoors.map((d) => `${d.dir} (the ${d.name}, locked)`);
    const ways = [...exits, ...locked];
    if (ways.length) lines.push(`Exits: ${ways.join(", ")}.`);
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

  renderExitDiff(before: ViewModel, after: ViewModel): string[] {
    const had = new Set(before.exits.map((e) => `${e.dir}->${e.toName}`));
    const opened = after.exits.filter((e) => !had.has(`${e.dir}->${e.toName}`));
    return opened.map((e) => `With a grinding click, the way ${e.dir} to the ${e.toName} opens.`);
  }

  renderQuery(query: "look" | "inventory" | "exits" | "help", vm: ViewModel): string[] {
    switch (query) {
      case "look": { this.visited.delete(vm.room.id); return this.renderRoom(vm); }
      case "inventory": {
        const names = [...vm.inventory.items.map((i) => i.name), ...vm.inventory.keys.map((k) => k.name)];
        return names.length ? [`You are carrying: ${names.join(", ")}.`] : ["You are carrying nothing."];
      }
      case "exits": {
        const ways = [...vm.exits.map((e) => `${e.dir} to the ${e.toName}`), ...vm.lockedDoors.map((d) => `${d.dir} (the ${d.name}, locked)`)];
        return ways.length ? [`Exits: ${ways.join(", ")}.`] : ["There are no obvious exits."];
      }
      case "help":
        return ["Commands: go <dir> (or n/s/e/w/…), look, examine <thing>, take/drop <thing>, open <chest>, unlock <door>, equip/use <thing>, attack <foe>, inventory, exits, wait, save, restore, undo."];
    }
  }

  renderExamine(target: ScopeEntity, _vm: ViewModel): string[] {
    return [`You look closely at the ${target.name}. Nothing more reveals itself — yet.`];
  }
}
