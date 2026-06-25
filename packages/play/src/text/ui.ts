import type { GameSession } from "../core/session.js";
import { parse } from "./parser.js";
import { Narrator } from "./narrator.js";
import { linkNouns } from "./link-nouns.js";

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
  let clickableNouns: string[] = [];

  // Typewriter state — one active animation at a time.
  let activeTypewriter: (() => void) | null = null;

  const prefersReducedMotion = (): boolean =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const computeClickableNouns = () => {
    const scope = session.view().scope;
    const all: string[] = [];
    for (const entity of scope) {
      all.push(entity.name, ...entity.aliases);
    }
    // De-duplicate (case-insensitive) while preserving original casing of first seen.
    const seen = new Set<string>();
    clickableNouns = all.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  /** Flush any in-progress typewriter immediately. */
  const flushTypewriter = () => {
    if (activeTypewriter) {
      activeTypewriter();
      activeTypewriter = null;
    }
  };

  /**
   * Append a block to #transcript containing the given line elements.
   * Returns the block element.
   */
  const appendBlock = (): HTMLDivElement => {
    const block = document.createElement("div");
    block.className = "block";
    transcript.appendChild(block);
    return block;
  };

  const appendLine = (block: HTMLElement, line: string, cls = "") => {
    const el = document.createElement("div");
    el.className = `line ${cls}`.trim();
    renderClickable(el, line, input, clickableNouns);
    block.appendChild(el);
  };

  /**
   * Print an array of lines as a single block.
   * Optional cls applies to every .line inside.
   */
  const print = (lines: string[], cls = "") => {
    const block = appendBlock();
    for (const line of lines) {
      appendLine(block, line, cls);
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
    computeClickableNouns();
  };

  /**
   * Render a room using renderRoomParts:
   * - header rendered instantly as .room-name
   * - description typed on character-by-character (unless reduced motion)
   * - body lines rendered instantly
   * All output goes into one block.
   */
  const printRoom = (vm: import("../core/viewmodel.js").ViewModel) => {
    flushTypewriter();
    const parts = narrator.renderRoomParts(vm);
    const block = appendBlock();

    // Header — instant, styled as heading
    const headerEl = document.createElement("div");
    headerEl.className = "line room-name";
    headerEl.textContent = parts.header;
    block.appendChild(headerEl);

    // Description — typewriter or instant
    if (parts.description !== null) {
      const descEl = document.createElement("div");
      descEl.className = "line";
      block.appendChild(descEl);

      if (prefersReducedMotion() || parts.description.length === 0) {
        descEl.textContent = parts.description;
      } else {
        const text = parts.description;
        let idx = 0;
        const CHAR_INTERVAL_MS = 22;
        const complete = () => {
          descEl.textContent = text;
          transcript.scrollTop = transcript.scrollHeight;
        };
        const timer = setInterval(() => {
          idx++;
          descEl.textContent = text.slice(0, idx);
          transcript.scrollTop = transcript.scrollHeight;
          if (idx >= text.length) {
            clearInterval(timer);
            activeTypewriter = null;
          }
        }, CHAR_INTERVAL_MS);
        activeTypewriter = () => {
          clearInterval(timer);
          complete();
        };
      }
    }

    // Body lines — instant, clickable
    for (const line of parts.body) {
      appendLine(block, line);
    }

    transcript.scrollTop = transcript.scrollHeight;
  };

  // Seed clickableNouns before the first room render so opening-room nouns are clickable.
  computeClickableNouns();
  printRoom(session.view());
  refresh();

  async function onSubmit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const line = input.value.trim();
    if (!line) return;
    input.value = "";
    history.push(line); historyIdx = history.length;
    // Flush any in-progress typewriter before rendering new output.
    flushTypewriter();
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
        else if (res.meta === "restore") { const ok = await session.restore("slot1"); print([ok ? "Restored." : "No save found."]); if (ok) printRoom(session.view()); }
        else { const ok = session.undo(); print([ok ? "The last moment unwinds." : "Nothing to undo."]); if (ok) printRoom(session.view()); }
        refresh(); return;
      }
      case "intent": {
        const result = session.execute(res.intent);
        if (result.error) { print([result.error], "error"); return; }
        const after = session.view();
        print(narrator.renderCues(result.cues));
        if (res.intent.kind === "move") printRoom(after);
        refresh();
        if (after.finished) print(["", "— THE END —"], "end");
        return;
      }
    }
  }
}

// Wrap known scope nouns in the printed line with clickable spans that pre-fill
// "examine <noun>" (confirm with Enter — never fires an action on click).
function renderClickable(el: HTMLElement, line: string, input: HTMLInputElement, nouns: string[]): void {
  const segments = linkNouns(line, nouns);
  for (const seg of segments) {
    if (seg.noun !== undefined) {
      const span = document.createElement("span");
      span.className = "noun";
      span.textContent = seg.text;
      span.addEventListener("click", () => { input.value = `examine ${seg.noun}`; input.focus(); });
      el.appendChild(span);
    } else {
      el.appendChild(document.createTextNode(seg.text));
    }
  }
}

function applyStyles(root: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --font-body: "VT323", ui-monospace, monospace;
      --font-head: "Silkscreen", "VT323", monospace;
      --color-bg: #14130f;
      --color-text: #cdd2c4;
      --color-accent: #d9c27a;
      --color-muted: #8a8f80;
      --color-error: #c98b6b;
      --color-border: #2a281f;
      --color-chip-bg: #25241d;
      --color-chip-border: #3a382e;
      --color-input: #e7e9df;
    }
    body { margin: 0; background: var(--color-bg); }
    .screen {
      max-width: 760px; margin: 0 auto; height: 100vh;
      display: flex; flex-direction: column;
      font: 19px/1.5 var(--font-body); color: var(--color-text); background: var(--color-bg);
      text-shadow: 0 0 8px rgba(205, 210, 196, 0.18);
    }
    .transcript { flex: 1; overflow-y: auto; padding: 1rem; }
    .block { margin-bottom: 0.9rem; }
    .line { white-space: pre-wrap; }
    .line.echo { color: var(--color-muted); }
    .line.error { color: var(--color-error); }
    .line.end { color: var(--color-accent); }
    .room-name {
      font-family: var(--font-head);
      font-weight: bold;
      font-size: 1.15em;
      letter-spacing: 0.05em;
      color: var(--color-accent);
      text-shadow: 0 0 12px rgba(217, 194, 122, 0.35);
      margin-bottom: 0.15em;
    }
    .compass { display: flex; gap: .4rem; flex-wrap: wrap; padding: .4rem 1rem; }
    .chip {
      background: var(--color-chip-bg); color: var(--color-text);
      border: 1px solid var(--color-chip-border); border-radius: 4px;
      padding: .15rem .5rem; cursor: pointer; font: inherit;
    }
    .status { padding: .3rem 1rem; color: var(--color-muted); border-top: 1px solid var(--color-border); }
    .prompt { display: flex; gap: .5rem; align-items: center; padding: .5rem 1rem 1rem; }
    .caret { color: var(--color-accent); }
    #cmd {
      flex: 1; background: transparent; border: none;
      color: var(--color-input); font: inherit; outline: none;
    }
    .noun {
      cursor: pointer; text-decoration: underline dotted;
      text-underline-offset: 2px; color: var(--color-text);
    }`;
  root.appendChild(style);
}
