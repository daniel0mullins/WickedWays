import type { CampaignManifest, SurfaceChoice } from "./manifest.js";
import type { PlaySurface, SurfaceHandle } from "./surface.js";
import type { SaveStore } from "./savestore.js";
import { GameSession } from "./session.js";
import { AudioRuntime } from "./audio/audio-runtime.js";
import { initEngine } from "#engine";
import "./components/campaign-menu.js";
import "./components/surface-picker.js";

/** Finds a campaign by slug from the registered list; returns `null` if not found. */
export function resolveCampaign(slug: string | null, campaigns: CampaignManifest[]): CampaignManifest | null {
  if (!slug) return null;
  return campaigns.find((c) => c.slug === slug) ?? null;
}

export interface BootOpts { saveStore: SaveStore; now: () => number; locationSearch?: string }

/**
 * Wires the campaign registry, surfaces, and save store into the root DOM element.
 *
 * **Boot flow:**
 * 1. Reads `?campaign=<slug>` from the URL. If a matching campaign is found:
 *    - If `?surface=<id>` is also present and valid for that campaign → deep-link mounts
 *      that surface directly.
 *    - Otherwise if the campaign offers ≥2 surfaces → shows the **surface picker**.
 *    - Otherwise → mounts the sole/default surface directly.
 * 2. Without `?campaign=` → renders the **campaign menu**.
 * 3. Selecting a campaign → goes to the surface flow above.
 * 4. Selecting a surface (or mounting directly) → sets `?campaign=`+`?surface=` in history,
 *    builds an `AudioRuntime`, starts a `GameSession`, and calls `surface.mount(...)`.
 *    Passes `initialThemeId` (from `?theme=`) and `onThemeChange` (writes `?theme=`).
 * 5. `onExit` ("back to menu"): calls `handle.unmount()`, clears `?campaign=`/`?surface=`/
 *    `?theme=`, and re-renders the menu.
 * 6. Surface-picker `back`: same cleanup as `onExit` but without unmounting a surface.
 *
 * @param app - Root `HTMLElement` (e.g. `document.getElementById("app")`).
 * @param reg - Registered campaigns and surfaces; the shell injects these at startup.
 * @param opts - Save store and clock; `locationSearch` overrides `window.location.search`
 *               (useful in unit tests that run without a real DOM).
 */
export async function bootLauncher(
  app: HTMLElement,
  reg: { campaigns: CampaignManifest[]; surfaces: PlaySurface[] },
  opts: BootOpts,
): Promise<void> {
  // One-time WASM init: after this resolves, GameSession.start (inside
  // mountSurface) constructs Authorities synchronously.
  await initEngine();
  let handle: SurfaceHandle | null = null;

  /** Returns the current URL search string; honours test injection via opts.locationSearch. */
  const currentSearch = (): string => opts.locationSearch ?? window.location.search;

  /** Set a single URL param via history.replaceState (no-op in environments where it throws). */
  const setParam = (key: string, value: string): void => {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set(key, value);
      window.history.replaceState(null, "", u);
    } catch {
      /* non-http environments (e.g. about:blank security error) — silently skip */
    }
  };

  /** Remove one or more URL params via history.replaceState. */
  const clearParams = (...keys: string[]): void => {
    try {
      const u = new URL(window.location.href);
      for (const k of keys) u.searchParams.delete(k);
      window.history.replaceState(null, "", u);
    } catch {
      /* non-http environments — silently skip */
    }
  };

  /** Normalises a campaign's surface declarations, falling back to the default CRT terminal. */
  const surfaceChoices = (m: CampaignManifest): readonly SurfaceChoice[] =>
    m.surfaces && m.surfaces.length ? m.surfaces : [{ id: "crt-terminal" }];

  /**
   * Mount a specific surface choice: sets URL params, builds session + audio, calls mount.
   * Reads `?theme=` from the current search to hydrate `initialThemeId`.
   */
  const mountSurface = (m: CampaignManifest, choice: SurfaceChoice): void => {
    const surface = reg.surfaces.find((s) => s.id === choice.id) ?? reg.surfaces[0]!;
    setParam("campaign", m.slug);
    setParam("surface", surface.id);
    const themes = choice.themes && choice.themes.length ? [...choice.themes] : [surface.defaultTheme];
    const initialThemeId = new URLSearchParams(currentSearch()).get("theme") ?? undefined;
    const session = GameSession.start({
      builder: m.builder(), registry: m.registry(), aliases: m.aliases,
      behaviors: m.behaviors?.() ?? {},
      formations: m.formations?.() ?? {},
      playerName: m.playerName, archetype: m.archetype, saveStore: opts.saveStore, now: opts.now,
    });
    const audio = AudioRuntime.forCampaign(m.audio);
    handle = surface.mount({
      app, session, manifest: m, themes, audio,
      initialThemeId,
      onThemeChange: (id) => setParam("theme", id),
      onExit: () => {
        handle?.unmount();
        handle = null;
        clearParams("campaign", "surface", "theme");
        showMenu();
      },
    });
  };

  /**
   * If the campaign offers ≥2 surfaces, render the `<surface-picker>`.
   * If only one surface is available, mount it directly.
   */
  const chooseSurface = (m: CampaignManifest): void => {
    const choices = surfaceChoices(m);
    if (choices.length < 2) { mountSurface(m, choices[0]!); return; }

    app.replaceChildren();
    const picker = document.createElement("surface-picker");
    picker.surfaces = choices.map((c) => {
      const s = reg.surfaces.find((x) => x.id === c.id);
      return { id: c.id, label: s?.label ?? c.id, description: s?.description };
    });
    picker.addEventListener("select", (e) => {
      const id = (e as CustomEvent<{ id: string }>).detail.id;
      const choice = choices.find((c) => c.id === id)!;
      mountSurface(m, choice);
    });
    picker.addEventListener("back", () => {
      clearParams("campaign", "surface", "theme");
      showMenu();
    });
    app.appendChild(picker);
  };

  const showMenu = (): void => {
    app.replaceChildren();
    const menu = document.createElement("campaign-menu");
    menu.campaigns = reg.campaigns.map((m) => ({ slug: m.slug, title: m.title, blurb: m.blurb }));
    menu.addEventListener("select", (e) => {
      const slug = (e as CustomEvent<{ slug: string }>).detail.slug;
      const m = resolveCampaign(slug, reg.campaigns);
      if (m) chooseSurface(m);
    });
    app.appendChild(menu);
  };

  // --- Boot: deep-link or menu ---
  const search = currentSearch();
  const slug = new URLSearchParams(search).get("campaign");
  const surfaceId = new URLSearchParams(search).get("surface");
  const deep = resolveCampaign(slug, reg.campaigns);

  if (deep) {
    const choices = surfaceChoices(deep);
    const deepChoice = surfaceId ? choices.find((c) => c.id === surfaceId) : undefined;
    if (deepChoice) {
      mountSurface(deep, deepChoice);
    } else {
      chooseSurface(deep);
    }
  } else {
    showMenu();
  }
}
