import { describe, it, expect } from "vitest";
import type { CampaignManifest, SurfaceChoice } from "./manifest.js";

describe("manifest", () => {
  it("typechecks a manifest with surfaces defined", () => {
    const manifest: CampaignManifest = {
      slug: "test-campaign",
      title: "Test Campaign",
      blurb: "A test campaign",
      intro: "Welcome to the test campaign",
      builder: (() => ({} as unknown)) as CampaignManifest["builder"],
      registry: (() => ({} as unknown)) as CampaignManifest["registry"],
      aliases: {},
      playerName: "Player",
      archetype: "test",
      surfaces: [
        {
          id: "crt-terminal",
          themes: [{ id: "default", label: "Default" }],
        },
      ],
    };

    expect(manifest.slug).toBe("test-campaign");
    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.surfaces?.[0]?.id).toBe("crt-terminal");
  });

  it("typechecks a manifest with surfaces omitted", () => {
    const manifest: CampaignManifest = {
      slug: "test-campaign",
      title: "Test Campaign",
      blurb: "A test campaign",
      intro: "Welcome to the test campaign",
      builder: (() => ({} as unknown)) as CampaignManifest["builder"],
      registry: (() => ({} as unknown)) as CampaignManifest["registry"],
      aliases: {},
      playerName: "Player",
      archetype: "test",
    };

    expect(manifest.slug).toBe("test-campaign");
    expect(manifest.surfaces).toBeUndefined();
  });

  it("typechecks a SurfaceChoice with themes", () => {
    const choice: SurfaceChoice = {
      id: "crt-terminal",
      themes: [{ id: "default", label: "Default" }],
    };

    expect(choice.id).toBe("crt-terminal");
    expect(choice.themes).toHaveLength(1);
  });

  it("typechecks a SurfaceChoice without themes", () => {
    const choice: SurfaceChoice = {
      id: "point-and-click",
    };

    expect(choice.id).toBe("point-and-click");
    expect(choice.themes).toBeUndefined();
  });
});
