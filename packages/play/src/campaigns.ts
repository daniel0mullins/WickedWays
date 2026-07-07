import type { CampaignManifest } from "@wickedways/play-runtime";
import { hollowHouse } from "@wickedways/campaigns/hollow-house";
import { seed } from "@wickedways/campaigns/seed";

/**
 * The campaigns registered in the launcher — the single source of truth shared
 * by `main.ts` (the shipped app) and the manifest-boot guard test
 * (`core/manifest-boot.test.ts`), so every shipped campaign is automatically
 * boot-checked against the WASM Authority's `validate_mechanics`.
 */
export const SHIPPED_CAMPAIGNS: CampaignManifest[] = [hollowHouse, seed];
