/**
 * Browser engine loader: the bundler-target build initializes through the
 * module graph (ESM wasm integration — vite-plugin-wasm in @wickedways/play).
 * One-time async init; afterwards engine() is synchronous so GameSession.start
 * keeps its sync signature.
 */
import type { EngineModule } from "./engine-types.js";

let mod: EngineModule | null = null;

export async function initEngine(): Promise<void> {
  if (mod) return;
  mod = (await import(
    "../../../crates/wickedways-wasm/pkg-web/wickedways_wasm.js"
  )) as unknown as EngineModule;
}

export function engine(): EngineModule {
  if (!mod) {
    throw new Error("engine not initialized: await initEngine() before GameSession.start");
  }
  return mod;
}
