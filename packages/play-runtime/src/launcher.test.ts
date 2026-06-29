// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./session.js", () => ({
  GameSession: { start: vi.fn().mockReturnValue({}) },
}));

vi.mock("./audio/audio-runtime.js", () => ({
  AudioRuntime: { forCampaign: vi.fn().mockReturnValue({}) },
}));

import { resolveCampaign, bootLauncher } from "./launcher.js";
import type { CampaignManifest } from "./manifest.js";
import type { CampaignMenu } from "./components/campaign-menu.js";
import type { MountArgs, SurfaceHandle } from "./surface.js";

const mk = (slug: string): CampaignManifest => ({ slug, title: slug, blurb: `blurb-${slug}`, intro: "", builder: (() => ({})) as never, registry: (() => ({})) as never, aliases: {}, playerName: "p", archetype: "a" });

const mkSurface = (id: string, label: string, description?: string, themes?: { id: string; label: string }[]) => {
  const mountSpy = vi.fn((_args: MountArgs): SurfaceHandle => ({ unmount: vi.fn() }));
  return {
    id,
    label,
    description,
    defaultTheme: { id: "default", label: "Default" },
    mount: mountSpy,
    themes,
  };
};

const saveStore = { load: () => null, save: () => undefined } as never;

describe("resolveCampaign", () => {
  const all = [mk("hollow-house"), mk("seed")];
  it("resolves an exact slug", () => { expect(resolveCampaign("seed", all)?.slug).toBe("seed"); });
  it("returns null for an unknown slug (→ menu)", () => { expect(resolveCampaign("nope", all)).toBeNull(); });
  it("returns null for no slug (→ menu)", () => { expect(resolveCampaign(null, all)).toBeNull(); });
});

describe("bootLauncher menu path", () => {
  it("renders <campaign-menu> with one entry per registered campaign when no ?campaign= is set", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);

    const campaigns = [mk("hollow-house"), mk("seed")];

    bootLauncher(
      app,
      { campaigns, surfaces: [] },
      { saveStore, now: () => 0, locationSearch: "" },
    );

    const menuEl = app.querySelector("campaign-menu") as CampaignMenu & { updateComplete: Promise<boolean> };
    expect(menuEl).not.toBeNull();
    expect(menuEl.campaigns).toHaveLength(2);
    expect(menuEl.campaigns[0]!.slug).toBe("hollow-house");
    expect(menuEl.campaigns[1]!.slug).toBe("seed");

    app.remove();
  });
});

describe("bootLauncher surface picker", () => {
  let app: HTMLElement;

  afterEach(() => {
    app.remove();
    // Reset window.location to a clean state between tests (must stay same-origin)
    window.history.replaceState(null, "", "/");
  });

  it("renders <surface-picker> populated with both surfaces when campaign has ≥2 surfaces and no ?surface=", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    const crt = mkSurface("crt-terminal", "CRT Terminal", "Classic text interface.");
    const pnc = mkSurface("point-and-click", "Point & Click", "Visual adventure interface.");
    const campaign: CampaignManifest = {
      ...mk("hollow-house"),
      surfaces: [{ id: "crt-terminal" }, { id: "point-and-click" }],
    };

    // ?campaign= is set but ?surface= is absent → chooseSurface → picker shown
    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt, pnc] },
      { saveStore, now: () => 0, locationSearch: "?campaign=hollow-house" },
    );

    const picker = app.querySelector("surface-picker") as (HTMLElement & { surfaces: { id: string; label: string; description?: string }[] }) | null;
    expect(picker).not.toBeNull();
    expect(picker!.surfaces).toHaveLength(2);
    expect(picker!.surfaces[0]!.id).toBe("crt-terminal");
    expect(picker!.surfaces[0]!.label).toBe("CRT Terminal");
    expect(picker!.surfaces[0]!.description).toBe("Classic text interface.");
    expect(picker!.surfaces[1]!.id).toBe("point-and-click");
    expect(picker!.surfaces[1]!.label).toBe("Point & Click");
    expect(picker!.surfaces[1]!.description).toBe("Visual adventure interface.");
    expect(crt.mount).not.toHaveBeenCalled();
    expect(pnc.mount).not.toHaveBeenCalled();
  });

  it("deep-links: ?campaign=&surface= mounts the named surface directly without showing the picker", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const pnc = mkSurface("point-and-click", "Point & Click");
    const campaign: CampaignManifest = {
      ...mk("hollow-house"),
      surfaces: [{ id: "crt-terminal" }, { id: "point-and-click" }],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt, pnc] },
      { saveStore, now: () => 0, locationSearch: "?campaign=hollow-house&surface=point-and-click" },
    );

    expect(pnc.mount).toHaveBeenCalledOnce();
    expect(crt.mount).not.toHaveBeenCalled();
    expect(app.querySelector("surface-picker")).toBeNull();
    expect(window.location.search).toContain("surface=point-and-click");
  });

  it("mounts the sole surface directly when campaign has fewer than 2 surfaces (no picker)", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const campaign: CampaignManifest = {
      ...mk("seed"),
      surfaces: [{ id: "crt-terminal" }],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt] },
      { saveStore, now: () => 0, locationSearch: "?campaign=seed" },
    );

    expect(crt.mount).toHaveBeenCalledOnce();
    expect(app.querySelector("surface-picker")).toBeNull();
    expect(window.location.search).toContain("surface=crt-terminal");
  });

  it("selecting a surface in the picker mounts the correct surface", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const pnc = mkSurface("point-and-click", "Point & Click");
    const campaign: CampaignManifest = {
      ...mk("hollow-house"),
      surfaces: [
        { id: "crt-terminal", themes: [{ id: "classic", label: "Classic" }] },
        { id: "point-and-click", themes: [{ id: "neon", label: "Neon" }] },
      ],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt, pnc] },
      { saveStore, now: () => 0, locationSearch: "?campaign=hollow-house" },
    );

    const picker = app.querySelector("surface-picker")!;
    expect(picker).not.toBeNull();

    picker.dispatchEvent(new CustomEvent("select", { detail: { id: "point-and-click" }, bubbles: true }));

    expect(pnc.mount).toHaveBeenCalledOnce();
    expect(crt.mount).not.toHaveBeenCalled();
    // Assert the mounted surface received its own themes, not the first surface's
    const args = pnc.mount.mock.calls[0]![0];
    expect(args.themes).toEqual([{ id: "neon", label: "Neon" }]);
  });

  it("passes initialThemeId from ?theme= to surface.mount", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const campaign: CampaignManifest = {
      ...mk("seed"),
      surfaces: [{ id: "crt-terminal", themes: [{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }] }],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt] },
      { saveStore, now: () => 0, locationSearch: "?campaign=seed&theme=dark" },
    );

    expect(crt.mount).toHaveBeenCalledOnce();
    const args = crt.mount.mock.calls[0]![0];
    expect(args.initialThemeId).toBe("dark");
    expect(args.themes).toEqual([{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }]);
  });

  it("onThemeChange sets ?theme= in window.location.search", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const campaign: CampaignManifest = {
      ...mk("seed"),
      surfaces: [{ id: "crt-terminal" }],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt] },
      { saveStore, now: () => 0, locationSearch: "?campaign=seed" },
    );

    const args = crt.mount.mock.calls[0]![0];
    expect(args.onThemeChange).toBeDefined();
    args.onThemeChange!("haunted");

    expect(window.location.search).toContain("theme=haunted");
  });

  it("picker 'back' clears ?campaign/?surface/?theme and re-shows the campaign menu", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    // Seed window.location with campaign, surface, and theme params so clearParams has something to clear
    window.history.replaceState(null, "", "/?campaign=hollow-house&surface=invalid&theme=dark");

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const pnc = mkSurface("point-and-click", "Point & Click");
    const campaign: CampaignManifest = {
      ...mk("hollow-house"),
      surfaces: [{ id: "crt-terminal" }, { id: "point-and-click" }],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt, pnc] },
      // locationSearch shows the campaign but no surface → chooseSurface → picker
      { saveStore, now: () => 0, locationSearch: "?campaign=hollow-house" },
    );

    const picker = app.querySelector("surface-picker")!;
    expect(picker).not.toBeNull();

    picker.dispatchEvent(new CustomEvent("back", { bubbles: true }));

    // Picker is gone, campaign menu is showing
    expect(app.querySelector("surface-picker")).toBeNull();
    expect(app.querySelector("campaign-menu")).not.toBeNull();

    // URL params cleared (including surface)
    expect(window.location.search).not.toContain("campaign");
    expect(window.location.search).not.toContain("surface");
    expect(window.location.search).not.toContain("theme");
  });

  it("surface onExit clears ?campaign/?surface/?theme and re-shows the campaign menu", () => {
    app = document.createElement("div");
    document.body.appendChild(app);

    window.history.replaceState(null, "", "/?campaign=seed&surface=crt-terminal&theme=dark");

    const crt = mkSurface("crt-terminal", "CRT Terminal");
    const campaign: CampaignManifest = {
      ...mk("seed"),
      surfaces: [{ id: "crt-terminal" }],
    };

    bootLauncher(
      app,
      { campaigns: [campaign], surfaces: [crt] },
      { saveStore, now: () => 0, locationSearch: "?campaign=seed&surface=crt-terminal" },
    );

    expect(crt.mount).toHaveBeenCalledOnce();
    const args = crt.mount.mock.calls[0]![0];
    args.onExit();

    // Surface is gone, campaign menu is showing
    expect(app.querySelector("campaign-menu")).not.toBeNull();

    // URL params cleared
    expect(window.location.search).not.toContain("campaign");
    expect(window.location.search).not.toContain("surface");
    expect(window.location.search).not.toContain("theme");
  });
});
