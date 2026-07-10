/** Shape of the wasm engine module (both wasm-pack targets emit it). Typed off
 *  the nodejs build's generated d.ts so typecheck requires `pnpm run wasm:build`
 *  to have run once. */
export type EngineModule = typeof import("../../../crates/wickedways-wasm/pkg-node/wickedways_wasm.js");
export type Authority = InstanceType<EngineModule["Authority"]>;
