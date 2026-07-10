import type { GameSession, AudioRuntime, SurfaceHandle, Theme, ViewModel, Intent } from "@wickedways/play-runtime";
import { MapModel } from "@wickedways/play-runtime";
import type { StatusField } from "wickedways/lib/presentation";
import { Narrator } from "../shared/narrator.js";
import { layoutMap, renderMapSvg } from "../shared/map-view.js";
import { sceneHotspots, inventoryActions, type Hotspot, type ActionDescriptor } from "./affordances.js";
import { type PncTheme, defaultPncTheme, applyPncTheme } from "./theme.js";
import { ensurePncTokens } from "./styles.js";
import type { MenuAction } from "./components/pnc-menu.js";
// Side-effect imports register the point-and-click custom elements.
import "./components/pnc-welcome.js";
import "./components/pnc-topbar.js";
import "./components/pnc-scene.js";
import "./components/pnc-status.js";
import "./components/pnc-inventory.js";
import "./components/pnc-log.js";
import "./components/pnc-action-menu.js";
import "./components/pnc-menu.js";
import "./components/pnc-map-overlay.js";

/**
 * Mount the point-and-click play surface as a component tree (`pnc-topbar`,
 * `pnc-scene`, a sidebar of `pnc-status`/`pnc-inventory`/`pnc-log`, with the
 * `pnc-welcome` overlay) and own the turn loop over it. The components are the
 * view; this controller owns the session, narrator, audio, map model, status
 * cues, action routing, and the turn loop. The cue-handling order mirrors the
 * CRT controller (status cues absorbed, step cues before resolution cues, mob
 * attacks between the action and its outcome), but output is routed to the
 * `pnc-log` and the affordance map drives clicks instead of a text parser.
 */
export function mountPointAndClick(
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
  ensurePncTokens(root.ownerDocument);

  const app = document.createElement("div");
  app.className = "pnc-app";
  app.dataset.pncApp = ""; // e2e/theme marker
  app.style.position = "relative";

  const topbar = document.createElement("pnc-topbar");
  const scene = document.createElement("pnc-scene");
  const status = document.createElement("pnc-status");
  const inventory = document.createElement("pnc-inventory");
  const log = document.createElement("pnc-log");

  const sidebar = document.createElement("aside");
  sidebar.className = "pnc-sidebar";
  sidebar.append(status, inventory, log);

  const stage = document.createElement("div");
  stage.className = "pnc-stage";
  stage.append(scene, sidebar);

  const welcome = document.createElement("pnc-welcome");
  welcome.title = meta.title;
  welcome.intro = meta.intro;
  welcome.buttonText = meta.buttonText;

  app.append(topbar, stage, welcome);
  root.appendChild(app);

  const initialTheme = (meta.initialThemeId
    ? meta.themes.find((t) => t.id === meta.initialThemeId)
    : undefined) ?? meta.themes[0];
  applyPncTheme(root, (initialTheme as PncTheme | undefined) ?? defaultPncTheme);

  // Topbar initial props.
  topbar.audioEnabled = false;
  topbar.soundpacks = audio.soundpacks;
  topbar.activeSoundpack = audio.soundpacks[0]?.id ?? "";
  topbar.themes = meta.themes;
  topbar.activeTheme = initialTheme?.id ?? "";

  // ── Controller state ────────────────────────────────────────────────────────
  let started = false;
  let interactionLocked = false;
  let latestStatus: readonly StatusField[] = [];
  let currentHotspots: Hotspot[] = [];
  let currentVm: ViewModel | undefined;
  let activeActionMenu: HTMLElement | null = null;

  const absorbStatusCues = (cues: readonly { kind: string; fields?: readonly StatusField[] }[]): void => {
    for (const cue of cues) {
      if (cue.kind === "status" && cue.fields !== undefined) latestStatus = cue.fields;
    }
  };

  const printRoom = (vm: ViewModel): void => {
    // The room name prints as a heading line (bold + underlined); the
    // description and any body lines follow as plain transcript text.
    const { header, description, body } = narrator.renderRoomParts(vm);
    log.print([header], "heading");
    const rest = description !== null ? [description, ...body] : body;
    if (rest.length) log.print(rest);
  };

  const refresh = (): void => {
    const vm = session.view();
    currentVm = vm;
    currentHotspots = sceneHotspots(vm);
    scene.hotspots = currentHotspots;
    scene.roomImage = vm.room.image;
    topbar.roomName = vm.status.locationName;
    status.fields = latestStatus;
    inventory.items = vm.inventory.items;
    inventory.keys = vm.inventory.keys;
    inventory.equippedNames = vm.inventory.equippedNames;
    inventory.slots = vm.inventory.slots;
    // Drive the ambient drone from the viewmodel each turn (DTO boundary —
    // no live engine object crosses the surface seam).
    audio.update(vm);
    mapModel.observe(vm);
  };

  // ── Action routing ────────────────────────────────────────────────────────────

  const runIntent = (intent: Intent): void => {
    const before = session.view();
    const result = session.execute(intent);
    if (result.error) {
      audio.noteError();
      log.print([result.error], "error");
      return;
    }
    absorbStatusCues(result.cues);
    const after = session.view();
    // Resolution (win/lose) cues are the OUTCOME — they must read after the mob's
    // retaliation that may have caused it, so split them off the rest.
    const resolutionCues = result.cues.filter((c) => c.kind === "resolution");
    const stepCues = result.cues.filter((c) => c.kind !== "resolution");
    for (const cue of stepCues) audio.playCue(cue, after);
    log.print([...narrator.renderAction(intent, before, after), ...narrator.renderCues(stepCues)]);
    if (intent.kind === "move") {
      mapModel.recordMove(before.room.id, intent.dir, after.room.id);
      printRoom(after);
    }
    // Mob reactions print after the room render on a move, so "you enter, you see
    // the Wraith, the Wraith strikes" reads in the right order.
    const mobAttacks = result.mobAttacks ?? [];
    for (const atk of mobAttacks) audio.playMobAttack(atk);
    const mobLines = narrator.renderMobAttacks(mobAttacks);
    if (mobLines.length) log.print(mobLines);
    // Then the outcome those events led to (death / victory), and the end.
    for (const cue of resolutionCues) audio.playCue(cue, after);
    const resolutionLines = narrator.renderCues(resolutionCues);
    if (resolutionLines.length) log.print(resolutionLines);
    refresh();
    if (after.finished) {
      log.print(["", "— THE END —"], "end");
      interactionLocked = true;
    }
  };

  // Examine is a generic look; Read surfaces an item's lore via the engine's
  // free, non-consuming read seam.
  const runExamine = (targetId: string): void => {
    const vm = session.view();
    const entity = vm.scope.find((e) => e.id === targetId);
    if (entity) log.print(narrator.renderExamine(entity, vm));
  };

  const runRead = (targetId: string): void => {
    const cues = session.read(targetId);
    absorbStatusCues(cues);
    if (cues.length) log.print(narrator.renderCues(cues));
  };

  const applyDescriptor = (desc: ActionDescriptor): void => {
    if (desc.kind === "intent") runIntent(desc.intent);
    else if (desc.kind === "read") runRead(desc.targetId);
    else runExamine(desc.targetId);
  };

  const closeActionMenu = (): void => {
    activeActionMenu?.remove();
    activeActionMenu = null;
  };

  const openActionMenu = (actions: ActionDescriptor[], x = 0, y = 0): void => {
    closeActionMenu();
    const menu = document.createElement("pnc-action-menu");
    menu.x = x;
    menu.y = y;
    menu.actions = actions.map((a, index) => ({ label: a.label, index }));
    menu.addEventListener("choose", (e) => {
      const index = (e as CustomEvent<{ index: number }>).detail.index;
      closeActionMenu();
      const desc = actions[index];
      if (desc) applyDescriptor(desc);
    });
    menu.addEventListener("dismiss", () => closeActionMenu());
    app.appendChild(menu);
    activeActionMenu = menu;
  };

  /** Open a menu for the hotspot's verbs, or fire a lone move-intent immediately. */
  const offerActions = (actions: ActionDescriptor[], x = 0, y = 0): void => {
    if (actions.length === 0) return;
    const only = actions.length === 1 ? actions[0] : undefined;
    if (only && only.kind === "intent" && only.intent.kind === "move") {
      applyDescriptor(only);
      return;
    }
    openActionMenu(actions, x, y);
  };

  // ── Overlays ──────────────────────────────────────────────────────────────────

  const openMap = (): void => {
    const overlay = document.createElement("pnc-map-overlay");
    overlay.svg = renderMapSvg(layoutMap(mapModel));
    overlay.addEventListener("dismiss", () => overlay.remove());
    app.appendChild(overlay);
  };

  const toggleFullscreen = (): void => {
    if (root.ownerDocument.fullscreenElement) {
      void root.ownerDocument.exitFullscreen?.();
    } else {
      void root.ownerDocument.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  };

  const runMenuCommand = async (action: MenuAction): Promise<void> => {
    switch (action) {
      case "save":
        await session.save("slot1", { map: mapModel.serialize() });
        log.print(["Saved."]);
        break;
      case "restore": {
        const { ok, surface } = await session.restore("slot1");
        log.print([ok ? "Restored." : "No save found."]);
        if (ok) {
          if (surface?.map) mapModel.hydrate(surface.map);
          printRoom(session.view());
        }
        break;
      }
      case "undo": {
        const ok = session.undo();
        log.print([ok ? "The last moment unwinds." : "Nothing to undo."]);
        if (ok) printRoom(session.view());
        break;
      }
      case "restart":
        session.restart();
        narrator = new Narrator();
        mapModel.reset();
        audio.reset();
        latestStatus = [];
        absorbStatusCues(session.takeStartupCues());
        interactionLocked = false;
        log.clear();
        printRoom(session.view());
        break;
      case "fullscreen":
        toggleFullscreen();
        return; // pure shell command — no game-state refresh
      case "exit":
        meta.onExit();
        return;
    }
    refresh();
  };

  const openMenu = (): void => {
    const menu = document.createElement("pnc-menu");
    menu.addEventListener("command", (e) => {
      const action = (e as CustomEvent<{ action: MenuAction }>).detail.action;
      menu.remove();
      void runMenuCommand(action);
    });
    menu.addEventListener("dismiss", () => menu.remove());
    app.appendChild(menu);
  };

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const startGame = (): void => {
    if (started) return;
    started = true;
    welcome.hidden = true;
    // Paint the opening status readout the campaign emitted at boot.
    absorbStatusCues(session.takeStartupCues());
    printRoom(session.view());
    refresh();
  };

  // ── Event wiring ──────────────────────────────────────────────────────────────
  welcome.addEventListener("enter", () => startGame());

  scene.addEventListener("hotspot", (e) => {
    if (interactionLocked) return;
    const { key, x = 0, y = 0 } = (e as CustomEvent<{ key: string; x?: number; y?: number }>).detail;
    const hs = currentHotspots.find((h) => h.key === key);
    if (hs) offerActions(hs.actions, x, y);
  });

  inventory.addEventListener("inventory-activate", (e) => {
    if (interactionLocked) return;
    const { id, x = 0, y = 0 } = (e as CustomEvent<{ id: string; x?: number; y?: number }>).detail;
    const vm = currentVm ?? session.view();
    const item = [...vm.inventory.items, ...vm.inventory.keys].find((i) => i.id === id);
    if (!item) return;
    const equipped = vm.inventory.equippedNames.includes(item.name);
    openActionMenu(inventoryActions(item, equipped), x, y);
  });

  topbar.addEventListener("toggle-audio", () => {
    audio.setEnabled(!audio.enabled);
    topbar.audioEnabled = audio.enabled;
  });
  topbar.addEventListener("soundpack-change", (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    audio.setSoundpack(id);
    topbar.activeSoundpack = id;
  });
  topbar.addEventListener("theme-change", (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    const chosen = meta.themes.find((t) => t.id === id);
    if (chosen) applyPncTheme(root, chosen as PncTheme);
    topbar.activeTheme = id;
    meta.onThemeChange?.(id);
  });
  topbar.addEventListener("open-map", () => openMap());
  topbar.addEventListener("open-menu", () => openMenu());

  return {
    unmount() {
      audio.dispose();
      // Removing the tree triggers disconnectedCallback teardown in the
      // components (window listeners, overlay key handlers, etc.).
      root.replaceChildren();
    },
  };
}
