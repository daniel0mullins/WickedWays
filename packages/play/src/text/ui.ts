import type { GameSession } from "../core/session.js";
import { parse } from "./parser.js";
import { Narrator } from "./narrator.js";

export function mountTerminal(root: HTMLElement, session: GameSession): void {
  const narrator = new Narrator();
  root.innerHTML = `
    <div class="screen">
      <div id="transcript" class="transcript" aria-live="polite"></div>
      <div id="compass" class="compass"></div>
      <div id="status" class="status"></div>
      <form id="prompt-form" class="prompt"><span class="caret">&gt;</span>
        <input id="cmd" autocomplete="off" autofocus /></form>
    </div>`;
  applyStyles(root);

  const transcript = root.querySelector<HTMLDivElement>("#transcript")!;
  const compass = root.querySelector<HTMLDivElement>("#compass")!;
  const status = root.querySelector<HTMLDivElement>("#status")!;
  const input = root.querySelector<HTMLInputElement>("#cmd")!;
  const form = root.querySelector<HTMLFormElement>("#prompt-form")!;
  const history: string[] = [];
  let historyIdx = 0;

  const print = (lines: string[], cls = "") => {
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = `line ${cls}`.trim();
      renderClickable(el, line, input);
      transcript.appendChild(el);
    }
    transcript.scrollTop = transcript.scrollHeight;
  };

  const refresh = () => {
    const vm = session.view();
    status.textContent = `${vm.status.locationName}  ·  turn ${vm.status.turn}/${vm.status.maxTurns}  ·  Sanity ${vm.status.sanity}`;
    compass.innerHTML = "";
    for (const e of vm.exits) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = `${e.dir} → ${e.toName}`;
      chip.addEventListener("click", () => { input.value = `go ${e.dir}`; input.focus(); });
      compass.appendChild(chip);
    }
  };

  print(narrator.renderRoom(session.view()));
  refresh();

  async function onSubmit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const line = input.value.trim();
    if (!line) return;
    input.value = "";
    history.push(line); historyIdx = history.length;
    print([`> ${line}`], "echo");
    await handle(line);
  }

  form.addEventListener("submit", (ev) => { void onSubmit(ev); });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp" && historyIdx > 0) { historyIdx--; input.value = history[historyIdx] ?? ""; }
    else if (ev.key === "ArrowDown" && historyIdx < history.length) { historyIdx++; input.value = history[historyIdx] ?? ""; }
  });

  async function handle(line: string): Promise<void> {
    const before = session.view();
    const res = parse(line, before);
    switch (res.kind) {
      case "error": print([res.message], "error"); return;
      case "ambiguous": print([`Which do you mean — ${res.candidates.map((c) => c.name).join(", or ")}?`]); return;
      case "query": print(narrator.renderQuery(res.query, before)); return;
      case "examine": print(narrator.renderExamine(res.target, before)); return;
      case "meta": {
        if (res.meta === "save") { await session.save("slot1"); print(["Saved."]); }
        else if (res.meta === "restore") { const ok = await session.restore("slot1"); print([ok ? "Restored." : "No save found."]); if (ok) print(narrator.renderQuery("look", session.view())); }
        else { const ok = session.undo(); print([ok ? "The last moment unwinds." : "Nothing to undo."]); if (ok) print(narrator.renderQuery("look", session.view())); }
        refresh(); return;
      }
      case "intent": {
        const result = session.execute(res.intent);
        if (result.error) { print([result.error], "error"); return; }
        const after = session.view();
        print(narrator.renderCues(result.cues));
        if (res.intent.kind === "move") print(narrator.renderRoom(after));
        refresh();
        if (after.finished) print(["", "— THE END —"], "end");
        return;
      }
    }
  }
}

// Wrap known scope nouns in the printed line with clickable spans that pre-fill
// "examine <noun>" (confirm with Enter — never fires an action on click).
function renderClickable(el: HTMLElement, line: string, input: HTMLInputElement): void {
  el.textContent = line; // v1: plain text. (Clickable-noun span-wrapping can be layered on here.)
  void input;
}

function applyStyles(root: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = `
    .screen { max-width: 760px; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; font: 15px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #cdd2c4; background: #14130f; }
    .transcript { flex: 1; overflow-y: auto; padding: 1rem; }
    .line { white-space: pre-wrap; }
    .line.echo { color: #8a8f80; } .line.error { color: #c98b6b; } .line.end { color: #d9c27a; }
    .compass { display: flex; gap: .4rem; flex-wrap: wrap; padding: .4rem 1rem; }
    .chip { background: #25241d; color: #cdd2c4; border: 1px solid #3a382e; border-radius: 4px; padding: .15rem .5rem; cursor: pointer; font: inherit; }
    .status { padding: .3rem 1rem; color: #8a8f80; border-top: 1px solid #2a281f; }
    .prompt { display: flex; gap: .5rem; align-items: center; padding: .5rem 1rem 1rem; }
    .caret { color: #d9c27a; } #cmd { flex: 1; background: transparent; border: none; color: #e7e9df; font: inherit; outline: none; }
    body { margin: 0; background: #14130f; }`;
  root.appendChild(style);
}
