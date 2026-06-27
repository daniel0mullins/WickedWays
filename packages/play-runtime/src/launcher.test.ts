import { describe, it, expect } from "vitest";
import { resolveCampaign } from "./launcher.js";
import type { CampaignManifest } from "./manifest.js";

const mk = (slug: string): CampaignManifest => ({ slug, title: slug, blurb: "", intro: "", builder: (() => ({})) as never, registry: (() => ({})) as never, aliases: {}, playerName: "p", archetype: "a" });

describe("resolveCampaign", () => {
  const all = [mk("hollow-house"), mk("seed")];
  it("resolves an exact slug", () => { expect(resolveCampaign("seed", all)?.slug).toBe("seed"); });
  it("returns null for an unknown slug (→ menu)", () => { expect(resolveCampaign("nope", all)).toBeNull(); });
  it("returns null for no slug (→ menu)", () => { expect(resolveCampaign(null, all)).toBeNull(); });
});
