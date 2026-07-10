/** Node engine loader: the nodejs-target build loads synchronously via
 *  require — initEngine() is a no-op await. Selected by the `default`
 *  condition of the #engine imports map (vitest, conformance, any Node host). */
import { createRequire } from "node:module";
import type { EngineModule } from "./engine-types.js";

const require = createRequire(import.meta.url);
const mod = require("../../../crates/wickedways-wasm/pkg-node/wickedways_wasm.js") as EngineModule;

export async function initEngine(): Promise<void> {
  /* nodejs target is ready at import time */
}
export function engine(): EngineModule {
  return mod;
}
