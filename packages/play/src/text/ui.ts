import type { GameSession } from "../core/session.js";
import type { StatusField } from "wickedways/lib/presentation";
import { parse } from "./parser.js";
import { Narrator } from "./narrator.js";
import type { AudioRuntime } from "../audio/audio-runtime.js";
import { linkNouns } from "./link-nouns.js";
import { MapModel } from "../core/map-model.js";
import { layoutMap, renderMapSvg } from "./map-view.js";
import type { SurfaceHandle, Theme } from "../core/surface.js";
import { type CrtTheme, defaultCrtTheme, applyTheme } from "./theme.js";

export function mountTerminal(
  root: HTMLElement,
  session: GameSession,
  meta: { title: string; intro: string; buttonText?: string; audio: AudioRuntime; themes: Theme[]; onExit(): void },
): SurfaceHandle {
  let narrator = new Narrator();
  const audio = meta.audio;
  const mapModel = new MapModel();
  root.innerHTML = `
    <div class="backdrop">
      <div class="monitor">
        <div class="monitor-screen">
          <div class="screen">
            <div class="welcome" aria-label="Welcome screen">
              <h1 class="welcome-title">${meta.title}</h1>
              <p class="welcome-intro">${meta.intro}</p>
              <button id="enter-game" class="enter-btn" type="button" autofocus>${meta.buttonText ?? `Enter ${meta.title}`}</button>
            </div>
            <div class="game-container" hidden>
              <div id="transcript" class="transcript" aria-live="polite"></div>
              <div id="hud" class="hud"></div>
              <div id="status" class="status"></div>
              <form id="prompt-form" class="prompt"><span class="caret">&gt;</span>
                <input id="cmd" type="text" autocomplete="off" /></form>
            </div>
          </div>
          <div class="crt-overlay" aria-hidden="true"></div>
          <div class="crt-sweep" aria-hidden="true"></div>
        </div>
        <div class="monitor-bezel-bottom">
          <span class="monitor-brand">WICKEDWAYS</span>
          <span class="monitor-vents" aria-hidden="true"></span>
          <button id="audio-toggle" class="monitor-btn" type="button" aria-pressed="false" aria-label="Toggle audio" title="Audio: off">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path class="spk" d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor"/>
              <path class="wave" d="M15.5 8 Q18.5 12 15.5 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path class="wave" d="M18 6 Q22.5 12 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <line class="mute-slash" x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
            </svg>
          </button>
          <select id="soundpack-select" class="monitor-select" aria-label="Sound pack" hidden></select>
          <select id="theme-select" class="monitor-select" aria-label="Theme" hidden></select>
          <button id="back-to-menu" class="monitor-btn monitor-btn-text" type="button" title="Back to menu" aria-label="Back to menu">&#x2190;</button>
          <span class="monitor-led" aria-hidden="true"></span>
        </div>
      </div>
    </div>`;
  applyTheme(root, (meta.themes[0] as CrtTheme) ?? defaultCrtTheme);
  applyStyles(root);

  const welcome = root.querySelector<HTMLDivElement>(".welcome")!;
  const gameContainer = root.querySelector<HTMLDivElement>(".game-container")!;
  const enterBtn = root.querySelector<HTMLButtonElement>("#enter-game")!;
  const transcript = root.querySelector<HTMLDivElement>("#transcript")!;
  const hud = root.querySelector<HTMLDivElement>("#hud")!;
  const status = root.querySelector<HTMLDivElement>("#status")!;
  const input = root.querySelector<HTMLInputElement>("#cmd")!;
  const form = root.querySelector<HTMLFormElement>("#prompt-form")!;
  const history: string[] = [];
  let historyIdx = 0;
  let clickableNouns: string[] = [];
  let gameStarted = false;
  // `restart` confirms first: the first one arms this flag, a second one fires;
  // any other command disarms it (see handle()).
  let restartPending = false;
  // Latest campaign-defined status bar fields (updated from status cues).
  // Empty until the first status cue arrives; bar shows just the location then.
  let latestStatus: readonly StatusField[] = [];

  const absorbStatusCues = (cues: readonly { kind: string; fields?: readonly StatusField[] }[]) => {
    for (const cue of cues) {
      if (cue.kind === "status" && cue.fields !== undefined) latestStatus = cue.fields;
    }
  };

  // Audio toggle — master switch on the bezel for procedural music + SFX.
  // Audio starts muted; the first enable resumes the AudioContext (the click, or
  // the Enter that submits the `audio` verb, is the required user gesture) and
  // starts the sanity-reactive ambient bed.
  const audioToggle = root.querySelector<HTMLButtonElement>("#audio-toggle")!;
  root.dataset.audio = "off"; // starts muted

  // Flip the master switch and mirror the REAL state onto the bezel button
  // (enabling no-ops if the AudioContext is unavailable). Shared by the button
  // and the `audio` verb so the two never drift. Returns the resulting state.
  const toggleAudio = (): boolean => {
    audio.setEnabled(!audio.enabled);
    const on = audio.enabled;
    audioToggle.setAttribute("aria-pressed", String(on));
    audioToggle.title = `Audio: ${on ? "on" : "off"}`;
    root.dataset.audio = on ? "on" : "off";
    return on;
  };
  audioToggle.addEventListener("click", () => {
    toggleAudio();
    if (gameStarted) input.focus(); // #cmd isn't focusable on the welcome screen
  });

  // Soundpack switcher — populate and show only when ≥2 packs are available.
  const soundpackSelect = root.querySelector<HTMLSelectElement>("#soundpack-select")!;
  if (audio.soundpacks.length >= 2) {
    for (const sp of audio.soundpacks) {
      const opt = document.createElement("option");
      opt.value = sp.id;
      opt.textContent = sp.label;
      soundpackSelect.appendChild(opt);
    }
    soundpackSelect.hidden = false;
    soundpackSelect.addEventListener("change", () => { audio.setSoundpack(soundpackSelect.value); });
  }

  // Theme switcher — shown only when ≥2 themes are available.
  const themeSelect = root.querySelector<HTMLSelectElement>("#theme-select")!;
  if (meta.themes.length >= 2) {
    for (const t of meta.themes) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      themeSelect.appendChild(opt);
    }
    themeSelect.hidden = false;
    themeSelect.addEventListener("change", () => {
      const chosen = meta.themes.find((t) => t.id === themeSelect.value);
      if (chosen) applyTheme(root, (chosen as CrtTheme));
    });
  }

  // Back to menu button.
  const backToMenuBtn = root.querySelector<HTMLButtonElement>("#back-to-menu")!;
  backToMenuBtn.addEventListener("click", () => { meta.onExit(); });

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
    // Status bar: location from the view model; stat readouts from the latest campaign cue.
    status.innerHTML = "";
    status.appendChild(document.createTextNode(vm.status.locationName));
    for (const f of latestStatus) {
      status.appendChild(document.createTextNode("  ·  "));
      const span = document.createElement("span");
      if (f.emphasis) span.className = `status-${f.emphasis}`;
      span.textContent = `${f.label} ${f.value}`;
      status.appendChild(span);
    }

    // Recompute clickable nouns first so the HUD loot line links the current scope.
    computeClickableNouns();

    // Persistent bottom HUD, driven from the viewmodel each turn.
    hud.innerHTML = "";

    // A HUD line that opens with a bold label ("Here:", "Carrying:", "Exits:")
    // followed by a space; the caller fills in the rest.
    const hudLine = (label: string): HTMLDivElement => {
      const line = document.createElement("div");
      line.className = "hud-line";
      const lbl = document.createElement("span");
      lbl.className = "hud-label";
      lbl.textContent = label;
      line.appendChild(lbl);
      line.appendChild(document.createTextNode(" "));
      return line;
    };

    // "Here:" loot line — omitted when there is no loot. Rendered through
    // renderClickable so loot nouns (e.g. "drawer") stay clickable affordances.
    // Descriptions already end in a period, so strip a trailing one before
    // re-punctuating the joined list (avoids "a drawer..").
    const lootDescs = vm.loot.map((l) => l.description.replace(/\.\s*$/, ""));
    if (lootDescs.length) {
      const hereLine = hudLine("Here:");
      renderClickable(hereLine, `${lootDescs.join(", ")}.`, input, clickableNouns);
      hud.appendChild(hereLine);
    }

    // "Carrying:" line — persistent inventory readout so gaining/losing an item
    // is always visible at a glance (the transcript confirms the action; this
    // shows the resulting state). Equipped gear is tagged; keys are listed too.
    const equipped = new Set(vm.inventory.equippedNames);
    const carried = [
      ...vm.inventory.items.map((i) => (equipped.has(i.name) ? `${i.name} (equipped)` : i.name)),
      ...vm.inventory.keys.map((k) => k.name),
      // Equipped gear that has left the items list still belongs on the readout.
      ...vm.inventory.equippedNames
        .filter((n) => !vm.inventory.items.some((i) => i.name === n))
        .map((n) => `${n} (equipped)`),
    ];
    const carryingLine = hudLine("Carrying:");
    renderClickable(carryingLine, `${carried.length ? carried.join(", ") : "nothing"}.`, input, clickableNouns);
    hud.appendChild(carryingLine);

    // "Exits:" line — passable exits as clickable text links (fill, no submit);
    // locked doors as dim, non-clickable text.
    const exitsLine = hudLine("Exits:");

    const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    const parts: Node[] = [];
    for (const e of vm.exits) {
      const link = document.createElement("span");
      link.className = "exit-link";
      link.textContent = cap(e.dir);
      link.addEventListener("click", () => { input.value = `go ${e.dir}`; input.focus(); });
      parts.push(link);
    }
    for (const d of vm.lockedDoors) {
      const locked = document.createElement("span");
      locked.className = "exit-locked";
      locked.textContent = `${cap(d.dir)} (${d.name}, locked)`;
      parts.push(locked);
    }
    if (parts.length === 0) {
      const none = document.createElement("span");
      none.className = "exit-locked";
      none.textContent = "none";
      parts.push(none);
    }
    parts.forEach((node, i) => {
      if (i > 0) exitsLine.appendChild(document.createTextNode(", "));
      exitsLine.appendChild(node);
    });
    hud.appendChild(exitsLine);
    // Drive the ambient drone from the live campaign each turn.
    audio.update(session.campaign);
    mapModel.observe(vm);
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
        // Type at full speed on first sight; twice as fast on a room you've seen.
        const CHAR_INTERVAL_MS = parts.firstVisit ? 22 : 11;
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

  // A single in-CRT overlay shared by the map and help screens: a bordered frame
  // plus a legend strip, dismissed by any keypress. Only one is open at a time.
  let overlay: HTMLDivElement | null = null;
  const closeOverlay = () => {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (gameStarted) input.focus();
  };
  const openOverlay = (fill: (frame: HTMLDivElement) => void, legendText: string) => {
    if (overlay) return; // idempotent
    const screen = root.querySelector<HTMLDivElement>(".screen")!;
    overlay = document.createElement("div");
    overlay.className = "overlay";
    const frame = document.createElement("div");
    frame.className = "overlay-frame";
    fill(frame);
    const legend = document.createElement("div");
    legend.className = "overlay-legend";
    legend.textContent = legendText;
    overlay.append(frame, legend);
    screen.appendChild(overlay);
    // Any keypress dismisses; capture so it never reaches #cmd.
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      window.removeEventListener("keydown", onKey, true);
      closeOverlay();
    };
    window.addEventListener("keydown", onKey, true);
  };
  const openMap = () =>
    openOverlay(
      (frame) => frame.appendChild(renderMapSvg(layoutMap(mapModel))),
      "─ open   ╌ locked   ? unexplored   ✕ remains   ▣ here   ·   any key to close",
    );
  const openHelp = () =>
    openOverlay((frame) => {
      const list = document.createElement("div");
      list.className = "help-list";
      for (const line of narrator.renderQuery("help", session.view())) {
        const row = document.createElement("div");
        row.className = "help-row";
        row.textContent = line;
        list.appendChild(row);
      }
      frame.appendChild(list);
    }, "any key to close");

  const startGame = () => {
    if (gameStarted) return;
    gameStarted = true;
    welcome.hidden = true;
    gameContainer.hidden = false;
    // Seed clickableNouns before the first room render so opening-room nouns are clickable.
    computeClickableNouns();
    printRoom(session.view());
    refresh();
    input.focus();
  };

  enterBtn.addEventListener("click", startGame);

  async function onSubmit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const line = input.value.trim();
    if (!line) return;
    input.value = "";
    history.push(line); historyIdx = history.length;
    // Flush any in-progress typewriter before rendering new output.
    flushTypewriter();
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
    // Echo the typed command into the log — except `map`/`help`, which only open
    // a transient overlay and would leave a bare `> map` with no response below it.
    const opensOverlay =
      (res.kind === "meta" && res.meta === "map") || (res.kind === "query" && res.query === "help");
    if (!opensOverlay) print([`> ${line}`], "echo");
    // Any command other than a confirming `restart` cancels a pending restart.
    if (restartPending && !(res.kind === "meta" && res.meta === "restart")) {
      restartPending = false;
    }
    switch (res.kind) {
      case "error": audio.noteError(); print([res.message], "error"); return;
      case "ambiguous": print([`Which do you mean — ${res.candidates.map((c) => c.name).join(", or ")}?`]); return;
      case "query":
        // `help` opens an in-CRT overlay (like `map`); the rest print inline.
        if (res.query === "help") { openHelp(); return; }
        print(narrator.renderQuery(res.query, before)); return;
      case "examine": {
        // Reading an item reveals its lore (engine-backed, free, non-consuming);
        // anything without lore falls back to the generic look line.
        const cues = res.target.kind === "item" ? session.read(res.target.id) : [];
        absorbStatusCues(cues);
        print(cues.length ? narrator.renderCues(cues) : narrator.renderExamine(res.target, before));
        return;
      }
      case "meta": {
        if (res.meta === "restart") {
          if (!restartPending) {
            restartPending = true;
            print(["Restart from the beginning? All progress will be lost. Type `restart` again to confirm."]);
            return;
          }
          restartPending = false;
          session.restart();
          narrator = new Narrator();      // reset narrator state for a clean restart
          mapModel.reset();
          latestStatus = [];
          transcript.innerHTML = "";
          printRoom(session.view());
          refresh();
          return;
        }
        if (res.meta === "fullscreen") {
          // Pure shell command — no game state changes, so no refresh. The Enter
          // keypress that submitted this counts as the required user gesture.
          if (document.fullscreenElement) {
            void document.exitFullscreen();
            print(["Leaving fullscreen."]);
          } else {
            void document.documentElement.requestFullscreen().then(
              () => print(["Entering fullscreen."]),
              () => print(["Fullscreen isn't available here."], "error"),
            );
          }
          input.focus();
          return;
        }
        if (res.meta === "audio") {
          // Shell command — mirrors the bezel toggle, spends no turn. The Enter
          // that submitted this is the gesture that lets the AudioContext resume.
          const on = toggleAudio();
          print([`Audio ${on ? "on" : "off"}.`]);
          input.focus();
          return;
        }
        if (res.meta === "map") { openMap(); return; }
        if (res.meta === "save") { await session.save("slot1", { map: mapModel.serialize() }); print(["Saved."]); }
        else if (res.meta === "restore") {
          const { ok, surface } = await session.restore("slot1");
          print([ok ? "Restored." : "No save found."]);
          if (ok) { if (surface?.map) mapModel.hydrate(surface.map); printRoom(session.view()); }
        }
        else { const ok = session.undo(); print([ok ? "The last moment unwinds." : "Nothing to undo."]); if (ok) printRoom(session.view()); }
        refresh(); return;
      }
      case "intent": {
        const result = session.execute(res.intent);
        if (result.error) { audio.noteError(); print([result.error], "error"); return; }
        absorbStatusCues(result.cues);
        const after = session.view();
        // Resolution (win/lose) cues are the OUTCOME — they must read after the
        // mob's retaliation that may have caused it, so split them off the rest.
        const resolutionCues = result.cues.filter((c) => c.kind === "resolution");
        const stepCues = result.cues.filter((c) => c.kind !== "resolution");
        for (const cue of stepCues) audio.playCue(cue, after);
        print([...narrator.renderAction(res.intent, before, after), ...narrator.renderCues(stepCues)]);
        if (res.intent.kind === "move") {
          mapModel.recordMove(before.room.id, res.intent.dir, after.room.id);
          printRoom(after);
        }
        // Mob reactions print after the room render on a move, so "you enter,
        // you see the Wraith, the Wraith strikes" reads in the right order.
        const mobAttacks = result.mobAttacks ?? [];
        for (const atk of mobAttacks) audio.playMobAttack(atk);
        const mobLines = narrator.renderMobAttacks(mobAttacks);
        if (mobLines.length) print(mobLines);
        // Then the outcome those events led to (death / victory), and the end.
        for (const cue of resolutionCues) audio.playCue(cue, after);
        const resolutionLines = narrator.renderCues(resolutionCues);
        if (resolutionLines.length) print(resolutionLines);
        refresh();
        if (after.finished) print(["", "— THE END —"], "end");
        return;
      }
    }
  }

  return {
    unmount() {
      root.replaceChildren();
    },
  };
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
      /* CRT theme defaults — overridden per-element by applyTheme */
      --crt-bg: #14130f;
      --crt-fg: #cdd2c4;
      --crt-accent: #d9c27a;
      --crt-warn: #e8d36b;
      --crt-critical: #c98b6b;
      --crt-font-body: "VT323", ui-monospace, monospace;
      --crt-font-display: "Silkscreen", "VT323", monospace;
      --crt-scanline: 0.22;
      --crt-glow: 0.18;
      --crt-flicker: 0.0;
      /* Derived aliases used throughout the rest of the CSS */
      --font-body: var(--crt-font-body);
      --font-head: var(--crt-font-display);
      --color-bg: var(--crt-bg);
      --color-text: var(--crt-fg);
      --color-accent: var(--crt-accent);
      --color-error: var(--crt-critical);
      --color-muted: #8a8f80;
      --color-border: #2a281f;
      --color-chip-bg: #25241d;
      --color-chip-border: #3a382e;
      --color-input: #e7e9df;
      /* Monitor housing — swap --plastic to e.g. #3a3a3e for a charcoal monitor. */
      --plastic: #cdbb97;
      --plastic-dark: #9c8a68;
      --plastic-light: #e4d6b6;
      --plastic-shadow: #6f6147;
      --led-color: #ffb347;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #0a0a0c; }

    /* (4) Backdrop — dark surround behind the monitor. */
    .backdrop {
      min-height: 100vh; width: 100%;
      display: flex; align-items: center; justify-content: center;
      padding: 2vmin;
      background: radial-gradient(ellipse at 50% 35%, #1c1b22 0%, #111016 55%, #08070a 100%);
    }

    /* (2) Monitor housing/cowling — molded plastic frame, pure CSS. */
    .monitor {
      --screen-h: min(82vh, calc((100vw - 14vmin) * 3 / 4));
      position: relative;
      padding: clamp(18px, 3vmin, 40px);
      padding-bottom: clamp(34px, 6vmin, 64px);
      border-radius: 28px;
      background:
        linear-gradient(160deg, var(--plastic-light) 0%, var(--plastic) 38%, var(--plastic-dark) 100%);
      box-shadow:
        inset 0 2px 3px rgba(255, 255, 255, 0.55),
        inset 0 -6px 14px rgba(0, 0, 0, 0.35),
        inset 8px 0 18px rgba(0, 0, 0, 0.12),
        inset -8px 0 18px rgba(0, 0, 0, 0.12),
        0 24px 60px rgba(0, 0, 0, 0.7),
        0 2px 0 rgba(255, 255, 255, 0.2);
    }

    /* Recessed well that the glass tube sits inside. */
    .monitor-screen {
      position: relative;
      height: var(--screen-h);
      aspect-ratio: 4 / 3;
      max-width: 100%;
      border-radius: 14px / 18px;
      overflow: hidden;
      background: #000;
      box-shadow:
        inset 0 0 0 3px var(--plastic-shadow),
        inset 0 0 14px 6px rgba(0, 0, 0, 0.9),
        0 0 2px rgba(0, 0, 0, 0.8);
    }

    /* (1) 4:3 screen — the live terminal fills the bounded glass.
       --base-size is the single knob; everything else is em-relative.
       (19px base, ~2x = 38px, then trimmed ~15% to 32px.) */
    .screen {
      position: absolute; inset: 0;
      --base-size: 32px;
      display: flex; flex-direction: column;
      font: var(--base-size)/1.5 var(--font-body); color: var(--color-text);
      /* faint bulged-glass curvature */
      background:
        radial-gradient(ellipse at 50% 45%, #1b1a14 0%, var(--color-bg) 70%, #0c0b08 100%);
      text-shadow: 0 0 8px rgba(205, 210, 196, 0.18);
      border-radius: 14px / 18px;
    }

    /* (3) CRT artifacts — overlays inside the bezel, above the transcript.
       HARD REQ: pointer-events:none so chips/nouns still receive clicks. */
    .crt-overlay {
      position: absolute; inset: 0;
      pointer-events: none;
      z-index: 5;
      border-radius: 14px / 18px;
      background:
        /* scanlines */
        repeating-linear-gradient(
          to bottom,
          rgba(0, 0, 0, 0.0) 0px,
          rgba(0, 0, 0, 0.0) 2px,
          rgba(0, 0, 0, 0.22) 3px,
          rgba(0, 0, 0, 0.22) 4px
        ),
        /* edge vignette / bulged-tube darkening */
        radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%);
      animation: crt-flicker 5s steps(60) infinite;
    }
    /* slow-moving scanline sweep */
    .crt-sweep {
      position: absolute; left: 0; right: 0; top: 0;
      height: 32%;
      pointer-events: none;
      z-index: 6;
      border-radius: 14px / 18px;
      background: linear-gradient(
        to bottom,
        rgba(217, 194, 122, 0) 0%,
        rgba(217, 194, 122, 0.045) 50%,
        rgba(217, 194, 122, 0) 100%
      );
      animation: crt-sweep 7s linear infinite;
    }
    @keyframes crt-flicker {
      0%, 100% { opacity: 1; }
      48% { opacity: 0.97; }
      50% { opacity: 0.93; }
      52% { opacity: 0.98; }
    }
    @keyframes crt-sweep {
      0% { transform: translateY(-40%); }
      100% { transform: translateY(360%); }
    }

    /* Bottom bezel strip — brand, vents, power LED. */
    .monitor-bezel-bottom {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: clamp(28px, 5vmin, 52px);
      display: flex; align-items: center; gap: 14px;
      padding: 0 clamp(22px, 4vmin, 48px);
    }
    .monitor-brand {
      font-family: var(--font-head);
      font-size: clamp(7px, 1.1vmin, 11px);
      letter-spacing: 0.18em;
      color: var(--plastic-shadow);
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.4);
    }
    .monitor-vents {
      flex: 1; height: 60%;
      background: repeating-linear-gradient(
        to right,
        rgba(0, 0, 0, 0.18) 0px,
        rgba(0, 0, 0, 0.18) 2px,
        rgba(255, 255, 255, 0.12) 3px,
        rgba(255, 255, 255, 0.12) 6px
      );
      border-radius: 3px;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
    }
    .monitor-led {
      width: 9px; height: 9px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #ffd98a, var(--led-color) 60%, #b46b00 100%);
      box-shadow: 0 0 6px 1px var(--led-color), inset 0 0 2px rgba(0,0,0,0.4);
    }
    .monitor-btn {
      appearance: none; -webkit-appearance: none;
      width: clamp(20px, 3.2vmin, 30px); height: clamp(20px, 3.2vmin, 30px);
      padding: 0; display: grid; place-items: center;
      border: 1px solid var(--plastic-shadow); border-radius: 5px;
      background: linear-gradient(#3a3026, #241c14);
      color: var(--color-text); cursor: pointer;
      box-shadow: inset 0 1px 1px rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.45);
    }
    .monitor-btn svg { width: 68%; height: 68%; display: block; }
    .monitor-btn:hover { color: #fff; }
    .monitor-btn:active { box-shadow: inset 0 1px 3px rgba(0,0,0,0.55); }
    .monitor-btn:focus-visible { outline: 2px solid var(--led-color); outline-offset: 2px; }
    .monitor-btn-text { font-family: var(--font-head); font-size: clamp(10px, 1.8vmin, 14px); padding: 0 0.4em; }
    .monitor-select {
      appearance: none; -webkit-appearance: none;
      height: clamp(20px, 3.2vmin, 30px);
      padding: 0 0.4em;
      border: 1px solid var(--plastic-shadow); border-radius: 5px;
      background: linear-gradient(#3a3026, #241c14);
      color: var(--color-text);
      font: clamp(7px, 1.1vmin, 11px) var(--font-head);
      letter-spacing: 0.08em;
      cursor: pointer;
      box-shadow: inset 0 1px 1px rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.45);
    }
    .monitor-select:focus-visible { outline: 2px solid var(--led-color); outline-offset: 2px; }
    /* Audio on: sound waves shown, no mute slash. */
    .monitor-btn[aria-pressed="true"] .mute-slash { display: none; }
    /* Audio off: hide waves, show slash, dim the icon. */
    .monitor-btn[aria-pressed="false"] { color: var(--color-muted); }
    .monitor-btn[aria-pressed="false"] .wave { display: none; }
    .monitor-btn[aria-pressed="false"] .mute-slash { display: block; }

    /* Welcome screen — fills the .screen, centered column layout.
       The [hidden] rule must override the flex display to properly hide it. */
    .welcome {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: clamp(1rem, 4%, 2.5rem);
      gap: 1.4em;
      z-index: 2;
      text-align: center;
    }
    .welcome[hidden] { display: none; }
    .welcome-title {
      font-family: var(--font-head);
      font-size: clamp(1.6em, 5vmin, 2.6em);
      letter-spacing: 0.08em;
      color: var(--color-accent);
      text-shadow: 0 0 18px rgba(217, 194, 122, 0.45), 0 0 4px rgba(217, 194, 122, 0.2);
      margin: 0;
      line-height: 1.2;
    }
    .welcome-intro {
      font-family: var(--font-body);
      font-size: clamp(0.85em, 2.2vmin, 1.1em);
      color: var(--color-text);
      line-height: 1.55;
      max-width: 36em;
      margin: 0;
    }
    .enter-btn {
      font-family: var(--font-head);
      font-size: clamp(1em, 3vmin, 1.5em);
      letter-spacing: 0.1em;
      padding: 0.55em 1.6em;
      background: transparent;
      color: var(--color-accent);
      border: 2px solid var(--color-accent);
      border-radius: 4px;
      cursor: pointer;
      /* Phosphor bloom — layered halo + text glow, breathing slowly. */
      text-shadow: 0 0 8px rgba(217, 194, 122, 0.55), 0 0 18px rgba(217, 194, 122, 0.32);
      box-shadow:
        0 0 6px rgba(217, 194, 122, 0.45),
        0 0 16px rgba(217, 194, 122, 0.30),
        0 0 34px rgba(217, 194, 122, 0.18),
        inset 0 0 10px rgba(217, 194, 122, 0.10);
      transition: background 0.15s, color 0.15s, box-shadow 0.25s, text-shadow 0.25s;
      animation: enter-bloom 2.6s ease-in-out infinite;
      margin-top: 0.4em;
    }
    .enter-btn:hover {
      background: rgba(217, 194, 122, 0.12);
      box-shadow:
        0 0 12px rgba(217, 194, 122, 0.8),
        0 0 30px rgba(217, 194, 122, 0.55),
        0 0 70px rgba(217, 194, 122, 0.40),
        inset 0 0 18px rgba(217, 194, 122, 0.20);
    }
    .enter-btn:focus-visible {
      outline: 2px solid var(--led-color);
      outline-offset: 3px;
    }
    .enter-btn:active {
      background: rgba(217, 194, 122, 0.22);
    }
    /* The bloom swells and recedes — a slow phosphor breath. */
    @keyframes enter-bloom {
      0%, 100% {
        box-shadow:
          0 0 6px rgba(217, 194, 122, 0.42),
          0 0 16px rgba(217, 194, 122, 0.28),
          0 0 34px rgba(217, 194, 122, 0.16),
          inset 0 0 10px rgba(217, 194, 122, 0.10);
        text-shadow: 0 0 8px rgba(217, 194, 122, 0.5), 0 0 16px rgba(217, 194, 122, 0.30);
      }
      50% {
        box-shadow:
          0 0 11px rgba(217, 194, 122, 0.72),
          0 0 26px rgba(217, 194, 122, 0.50),
          0 0 60px rgba(217, 194, 122, 0.34),
          inset 0 0 16px rgba(217, 194, 122, 0.18);
        text-shadow: 0 0 12px rgba(217, 194, 122, 0.78), 0 0 26px rgba(217, 194, 122, 0.46);
      }
    }

    /* Game container — takes over the full .screen flex column once welcome is hidden. */
    .game-container {
      display: flex; flex-direction: column;
      flex: 1; min-height: 0;
    }
    .game-container[hidden] { display: none; }

    .transcript { flex: 1; overflow-y: auto; padding: 1rem; position: relative; z-index: 1; }
    .block { margin-bottom: 0.35rem; }
    .line { white-space: pre-wrap; line-height: 1.2; }
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
    /* Persistent bottom HUD — Here: / Exits: lines, between transcript and status. */
    .hud {
      padding: .25rem 1rem; position: relative; z-index: 1;
      border-top: 1px solid var(--color-border);
      color: var(--color-text);
      display: flex; flex-direction: column; gap: .05em;
    }
    .hud-line { white-space: pre-wrap; line-height: 1.2; }
    .hud-label { font-weight: bold; color: color-mix(in srgb, var(--color-accent) 72%, var(--color-bg)); }
    .exit-link {
      cursor: pointer; text-decoration: underline;
      text-underline-offset: 2px; color: var(--color-accent);
    }
    .exit-locked { color: var(--color-muted); opacity: 0.7; }
    .status { padding: .3rem 1rem; color: var(--color-muted); border-top: 1px solid var(--color-border); position: relative; z-index: 1; }
    .status-critical { color: var(--color-error); }
    .status-warn { color: var(--color-accent); }
    .prompt { display: flex; gap: .5rem; align-items: center; padding: .5rem 1rem 1rem; position: relative; z-index: 1; }
    .caret { color: var(--color-accent); }
    #cmd {
      flex: 1; background: transparent; border: none;
      color: var(--color-input); font: inherit; outline: none;
    }
    .noun {
      cursor: pointer; text-decoration: underline dotted;
      text-underline-offset: 2px; color: var(--color-text);
    }

    /* (3) HARD REQ: all motion gated off when reduced motion is preferred. */
    @media (prefers-reduced-motion: reduce) {
      .crt-overlay { animation: none; }
      .crt-sweep { animation: none; display: none; }
      .enter-btn { animation: none; } /* keep the static bloom, drop the pulse */
    }

    /* Shared overlay (map + help) — inside the CRT, beneath the scanline/glow overlays (z 5–6). */
    .overlay {
      position: absolute; inset: 0; z-index: 3;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 0.6em; padding: 1rem;
      background: rgba(10, 10, 8, 0.92);
    }
    .overlay-frame {
      max-width: 100%; max-height: 80%; overflow: auto;
      padding: 0.8em; border-radius: 6px;
      border: 2px solid var(--color-accent);
      background: rgba(10, 10, 8, 0.6);
      box-shadow: 0 0 10px rgba(217, 194, 122, 0.35), inset 0 0 14px rgba(0, 0, 0, 0.5);
    }
    .help-list { display: flex; flex-direction: column; gap: 0.35em; }
    .help-row { font-family: var(--font-body); font-size: 0.8em; color: var(--color-text); white-space: nowrap; }
    .map-svg { max-width: 100%; height: auto; }
    .map-svg .map-box { fill: var(--color-chip-bg); stroke: var(--color-muted); stroke-width: 1.5; }
    .map-svg .map-box.current { stroke: var(--color-accent); stroke-width: 2.5;
      filter: drop-shadow(0 0 6px rgba(217, 194, 122, 0.7)); }
    .map-svg .map-label { fill: var(--color-text); font: 0.5em var(--font-body); }
    .map-svg .map-link { stroke: var(--color-muted); stroke-width: 2; }
    .map-svg .map-link.locked { stroke: var(--color-muted); stroke-dasharray: 4 4; }
    .map-svg .map-stub { stroke: var(--color-border); stroke-width: 2; }
    .map-svg .map-stub.locked { stroke: var(--color-border); stroke-dasharray: 4 4; }
    .map-svg .map-q { fill: var(--color-muted); font: 0.5em var(--font-body); }
    .map-svg .map-remains { fill: var(--color-error); font: 0.5em var(--font-body); }
    .overlay-legend { font-family: var(--font-body); font-size: 0.7em; color: var(--color-muted); text-align: center; }`;
  root.appendChild(style);
}
