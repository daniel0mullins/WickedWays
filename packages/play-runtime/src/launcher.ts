import type { CampaignManifest } from "./manifest.js";
import type { PlaySurface, SurfaceHandle } from "./surface.js";
import type { SaveStore } from "./savestore.js";
import { GameSession } from "./session.js";
import { AudioRuntime } from "./audio/audio-runtime.js";

/** Finds a campaign by slug from the registered list; returns `null` if not found. */
export function resolveCampaign(slug: string | null, campaigns: CampaignManifest[]): CampaignManifest | null {
  if (!slug) return null;
  return campaigns.find((c) => c.slug === slug) ?? null;
}

interface BootOpts { saveStore: SaveStore; now: () => number; locationSearch?: string }

/**
 * Wires the campaign registry, surfaces, and save store into the root DOM element.
 *
 * **Boot flow:**
 * 1. Reads `?campaign=<slug>` from the URL. If a matching campaign is found,
 *    boots it directly (**deep-link**), bypassing the menu.
 * 2. Otherwise renders the **campaign menu** — a surface-independent picker that
 *    lists each manifest's `title` and `blurb`. Keyboard and click both work.
 * 3. On select: sets `?campaign=<slug>` in history, resolves the campaign's
 *    designated surface (`manifest.surface ?? "crt-terminal"`), builds an
 *    `AudioRuntime` from `manifest.audio`, starts a `GameSession`, and calls
 *    `surface.mount(...)`.
 * 4. `onExit` ("back to menu"): calls `handle.unmount()`, clears `?campaign=`, and
 *    re-renders the menu. The "play again" restart path in the surface can also
 *    call `onExit` to return to the picker.
 *
 * @param app - Root `HTMLElement` (e.g. `document.getElementById("app")`).
 * @param reg - Registered campaigns and surfaces; the shell injects these at startup.
 * @param opts - Save store and clock; `locationSearch` overrides `window.location.search`
 *               (useful in unit tests that run without a real DOM).
 */
export function bootLauncher(
  app: HTMLElement,
  reg: { campaigns: CampaignManifest[]; surfaces: PlaySurface[] },
  opts: BootOpts,
): void {
  let handle: SurfaceHandle | null = null;

  const launch = (m: CampaignManifest): void => {
    const surface = reg.surfaces.find((s) => s.id === (m.surface ?? "crt-terminal")) ?? reg.surfaces[0]!;
    const url = new URL(window.location.href);
    url.searchParams.set("campaign", m.slug);
    window.history.replaceState(null, "", url);
    const session = GameSession.start({
      builder: m.builder(), registry: m.registry(), aliases: m.aliases,
      playerName: m.playerName, archetype: m.archetype, saveStore: opts.saveStore, now: opts.now,
    });
    const audio = AudioRuntime.forCampaign(m.audio);
    handle = surface.mount({
      app, session, manifest: m,
      themes: m.themes && m.themes.length ? m.themes : [surface.defaultTheme],
      audio,
      onExit: () => {
        handle?.unmount();
        handle = null;
        const u = new URL(window.location.href);
        u.searchParams.delete("campaign");
        window.history.replaceState(null, "", u);
        showMenu();
      },
    });
  };

  const showMenu = (): void => {
    app.replaceChildren();
    const menu = document.createElement("div");
    menu.className = "launcher-menu";
    for (const m of reg.campaigns) {
      const btn = document.createElement("button");
      btn.className = "launcher-entry";
      btn.innerHTML = `<span class="launcher-title">${m.title}</span><span class="launcher-blurb">${m.blurb}</span>`;
      btn.addEventListener("click", () => launch(m));
      menu.appendChild(btn);
    }
    app.appendChild(menu);
  };

  const search = opts.locationSearch ?? window.location.search;
  const slug = new URLSearchParams(search).get("campaign");
  const deep = resolveCampaign(slug, reg.campaigns);
  if (deep) launch(deep); else showMenu();
}
