// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { resolveCampaign, bootLauncher } from "./launcher.js";
import type { CampaignManifest } from "./manifest.js";
import type { CampaignMenu } from "./components/campaign-menu.js";

const mk = (slug: string): CampaignManifest => ({ slug, title: slug, blurb: `blurb-${slug}`, intro: "", builder: (() => ({})) as never, registry: (() => ({})) as never, aliases: {}, playerName: "p", archetype: "a" });

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
    const saveStore = {
      load: () => null,
      save: () => undefined,
    } as never;

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
