/** Browser engine loader (bundler-target build). Task 12 wires the actual
 *  dynamic import; until then any browser use fails loudly. */
import type { EngineModule } from "./engine-types.js";

export function initEngine(): Promise<void> {
  return Promise.reject(new Error("wasm engine web build not wired yet (Task 12)"));
}
export function engine(): EngineModule {
  throw new Error("engine not initialized: await initEngine() before GameSession.start");
}
