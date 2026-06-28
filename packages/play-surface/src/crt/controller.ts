import type { GameSession, AudioRuntime, SurfaceHandle, Theme } from "@wickedways/play-runtime";
import { MapModel } from "@wickedways/play-runtime";
import type { StatusField } from "wickedways/lib/presentation";
import { parse } from "./parser.js";
import { Narrator } from "../shared/narrator.js";
import { layoutMap, renderMapSvg } from "../shared/map-view.js";
import { type CrtTheme, defaultCrtTheme, applyTheme } from "./theme.js";
import { ensureGlobalTokens } from "./styles.js";
// Side-effect imports register the four top-level custom elements.
import "./components/crt-housing.js";
import "./components/crt-welcome.js";
import "./components/crt-game.js";
import "./components/crt-bezel.js";

/**
 * Mount the CRT play surface as a Lit component tree (`crt-housing` with slotted
 * `crt-welcome`/`crt-game`/`crt-bezel`) and own the turn loop over it. The
 * components are the view; this controller owns the session, parser, narrator,
 * audio, map model, status cues, and the turn loop. Behaviour is a faithful port
 * of the legacy `ui.ts mountTerminal`; the lone intentional change is disabling
 * the prompt when the campaign finishes.
 */
export function mountTerminal(
  root: HTMLElement,
  session: GameSession,
  meta: {
    title: string;
    intro: string;
    buttonText?: string;
    audio: AudioRuntime;
    themes: Theme[];
    onExit(): void;
    initialThemeId?: string;
    onThemeChange?: (id: string) => void;
  },
): SurfaceHandle {
  let narrator = new Narrator();
  const audio = meta.audio;
  const mapModel = new MapModel();

  // ── Component tree ──────────────────────────────────────────────────────────
  ensureGlobalTokens(root.ownerDocument);

  const housing = document.createElement("crt-housing");

  const welcome = document.createElement("crt-welcome");
  welcome.slot = "screen";
  welcome.title = meta.title;
  welcome.intro = meta.intro;
  welcome.buttonText = meta.buttonText;

  const game = document.createElement("crt-game");
  game.slot = "screen";
  game.hidden = true;

  const bezel = document.createElement("crt-bezel");
  bezel.slot = "bezel";
  bezel.audioEnabled = false;
  bezel.soundpacks = audio.soundpacks;
  bezel.activeSoundpack = audio.soundpacks[0]?.id ?? "";
  bezel.themes = meta.themes;
  const initialTheme = (meta.initialThemeId
    ? meta.themes.find((t) => t.id === meta.initialThemeId)
    : undefined) ?? meta.themes[0];
  bezel.activeTheme = initialTheme?.id ?? "";

  housing.append(welcome, game, bezel);
  root.appendChild(housing);
  root.dataset.crtHousing = ""; // preserve — e2e/theme marker
  applyTheme(root, (initialTheme as CrtTheme) ?? defaultCrtTheme);

  // ── Controller state ────────────────────────────────────────────────────────
  let gameStarted = false;
  // `restart` confirms first: the first one arms this flag, a second one fires;
  // any other command disarms it (see handle()).
  let restartPending = false;
  // Latest campaign-defined status bar fields (updated from status cues).
  // Empty until the first status cue arrives; bar shows just the location then.
  let latestStatus: readonly StatusField[] = [];
  let clickableNouns: string[] = [];

  const absorbStatusCues = (cues: readonly { kind: string; fields?: readonly StatusField[] }[]) => {
    for (const cue of cues) {
      if (cue.kind === "status" && cue.fields !== undefined) latestStatus = cue.fields;
    }
  };

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
    game.setClickableNouns(clickableNouns);
  };

  // Flip the master switch and mirror the REAL state onto the bezel button
  // (enabling no-ops if the AudioContext is unavailable). Shared by the button
  // and the `audio` verb so the two never drift. Returns the resulting state.
  const toggleAudio = (): boolean => {
    audio.setEnabled(!audio.enabled);
    bezel.audioEnabled = audio.enabled;
    return audio.enabled;
  };

  const refresh = () => {
    const vm = session.view();
    // Status bar: location from the view model; stat readouts from the latest campaign cue.
    game.setStatus(vm.status.locationName, latestStatus);
    // Recompute clickable nouns first so the HUD loot line links the current scope.
    computeClickableNouns();
    // Persistent bottom HUD, driven from the viewmodel each turn (rendered inside <crt-hud>).
    game.setHud(vm);
    // Drive the ambient drone from the live campaign each turn.
    audio.update(session.campaign);
    mapModel.observe(vm);
  };

  const startGame = () => {
    if (gameStarted) return;
    gameStarted = true;
    welcome.hidden = true;
    game.hidden = false;
    // Seed clickableNouns before the first room render so opening-room nouns are clickable.
    computeClickableNouns();
    game.transcript.printRoom(narrator.renderRoomParts(session.view()));
    refresh();
    game.focusInput();
  };

  async function handle(line: string): Promise<void> {
    const before = session.view();
    const res = parse(line, before);
    // Echo the typed command into the log — except `map`/`help`, which only open
    // a transient overlay and would leave a bare `> map` with no response below it.
    const opensOverlay =
      (res.kind === "meta" && res.meta === "map") || (res.kind === "query" && res.query === "help");
    if (!opensOverlay) game.transcript.print([`> ${line}`], "echo");
    // Any command other than a confirming `restart` cancels a pending restart.
    if (restartPending && !(res.kind === "meta" && res.meta === "restart")) {
      restartPending = false;
    }
    switch (res.kind) {
      case "error": audio.noteError(); game.transcript.print([res.message], "error"); return;
      case "ambiguous": game.transcript.print([`Which do you mean — ${res.candidates.map((c) => c.name).join(", or ")}?`]); return;
      case "query":
        // `help` opens an in-CRT overlay (like `map`); the rest print inline.
        if (res.query === "help") { game.openHelp(narrator.renderQuery("help", session.view())); return; }
        game.transcript.print(narrator.renderQuery(res.query, before)); return;
      case "examine": {
        // Reading an item reveals its lore (engine-backed, free, non-consuming);
        // anything without lore falls back to the generic look line.
        const cues = res.target.kind === "item" ? session.read(res.target.id) : [];
        absorbStatusCues(cues);
        game.transcript.print(cues.length ? narrator.renderCues(cues) : narrator.renderExamine(res.target, before));
        return;
      }
      case "meta": {
        if (res.meta === "restart") {
          if (!restartPending) {
            restartPending = true;
            game.transcript.print(["Restart from the beginning? All progress will be lost. Type `restart` again to confirm."]);
            return;
          }
          restartPending = false;
          session.restart();
          narrator = new Narrator();      // reset narrator state for a clean restart
          mapModel.reset();
          audio.reset();                  // recreate director so the tension high-water-mark resets
          latestStatus = [];
          game.clearTranscript();
          game.transcript.printRoom(narrator.renderRoomParts(session.view()));
          refresh();
          return;
        }
        if (res.meta === "fullscreen") {
          // Pure shell command — no game state changes, so no refresh. The Enter
          // keypress that submitted this counts as the required user gesture.
          if (document.fullscreenElement) {
            void document.exitFullscreen();
            game.transcript.print(["Leaving fullscreen."]);
          } else {
            void document.documentElement.requestFullscreen().then(
              () => game.transcript.print(["Entering fullscreen."]),
              () => game.transcript.print(["Fullscreen isn't available here."], "error"),
            );
          }
          game.focusInput();
          return;
        }
        if (res.meta === "audio") {
          // Shell command — mirrors the bezel toggle, spends no turn. The Enter
          // that submitted this is the gesture that lets the AudioContext resume.
          const on = toggleAudio();
          game.transcript.print([`Audio ${on ? "on" : "off"}.`]);
          game.focusInput();
          return;
        }
        if (res.meta === "map") { game.openMap(renderMapSvg(layoutMap(mapModel))); return; }
        if (res.meta === "save") { await session.save("slot1", { map: mapModel.serialize() }); game.transcript.print(["Saved."]); }
        else if (res.meta === "restore") {
          const { ok, surface } = await session.restore("slot1");
          game.transcript.print([ok ? "Restored." : "No save found."]);
          if (ok) { if (surface?.map) mapModel.hydrate(surface.map); game.transcript.printRoom(narrator.renderRoomParts(session.view())); }
        }
        else { const ok = session.undo(); game.transcript.print([ok ? "The last moment unwinds." : "Nothing to undo."]); if (ok) game.transcript.printRoom(narrator.renderRoomParts(session.view())); }
        refresh(); return;
      }
      case "intent": {
        const result = session.execute(res.intent);
        if (result.error) { audio.noteError(); game.transcript.print([result.error], "error"); return; }
        absorbStatusCues(result.cues);
        const after = session.view();
        // Resolution (win/lose) cues are the OUTCOME — they must read after the
        // mob's retaliation that may have caused it, so split them off the rest.
        const resolutionCues = result.cues.filter((c) => c.kind === "resolution");
        const stepCues = result.cues.filter((c) => c.kind !== "resolution");
        for (const cue of stepCues) audio.playCue(cue, after);
        game.transcript.print([...narrator.renderAction(res.intent, before, after), ...narrator.renderCues(stepCues)]);
        if (res.intent.kind === "move") {
          mapModel.recordMove(before.room.id, res.intent.dir, after.room.id);
          game.transcript.printRoom(narrator.renderRoomParts(after));
        }
        // Mob reactions print after the room render on a move, so "you enter,
        // you see the Wraith, the Wraith strikes" reads in the right order.
        const mobAttacks = result.mobAttacks ?? [];
        for (const atk of mobAttacks) audio.playMobAttack(atk);
        const mobLines = narrator.renderMobAttacks(mobAttacks);
        if (mobLines.length) game.transcript.print(mobLines);
        // Then the outcome those events led to (death / victory), and the end.
        for (const cue of resolutionCues) audio.playCue(cue, after);
        const resolutionLines = narrator.renderCues(resolutionCues);
        if (resolutionLines.length) game.transcript.print(resolutionLines);
        refresh();
        if (after.finished) {
          game.transcript.print(["", "— THE END —"], "end");
          game.setPromptDisabled(true);
        }
        return;
      }
    }
  }

  // ── Event wiring ────────────────────────────────────────────────────────────
  welcome.addEventListener("enter", () => startGame());

  game.addEventListener("command", (e) => {
    const line = (e as CustomEvent<{ line: string }>).detail.line;
    game.transcript.flush(); // original flushed the typewriter before handling
    void handle(line);
  });

  bezel.addEventListener("toggle-audio", () => {
    toggleAudio();
    if (gameStarted) game.focusInput(); // the prompt isn't focusable on the welcome screen
  });
  bezel.addEventListener("soundpack-change", (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    audio.setSoundpack(id);
    bezel.activeSoundpack = id;
  });
  bezel.addEventListener("theme-change", (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    const chosen = meta.themes.find((t) => t.id === id);
    if (chosen) applyTheme(root, chosen as CrtTheme);
    bezel.activeTheme = id;
    meta.onThemeChange?.(id);
  });
  bezel.addEventListener("exit", () => meta.onExit());

  return {
    unmount() {
      audio.dispose();
      // Removing the housing triggers disconnectedCallback teardown in
      // crt-transcript (typewriter interval) and crt-game (window keydown listener).
      root.replaceChildren();
    },
  };
}
