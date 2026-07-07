// Asserts the DEFAULT (no-conformance) wasm build in pkg-node/ is clean:
// no conformance-only free function in the JS glue, and no "conformance:"
// registry key baked into the wasm binary. Extended in Task 7 to also
// require the Authority class. Run after `pnpm run wasm:build`.
import { readFileSync } from "node:fs";

const jsPath = "crates/wickedways-wasm/pkg-node/wickedways_wasm.js";
const wasmPath = "crates/wickedways-wasm/pkg-node/wickedways_wasm_bg.wasm";

const js = readFileSync(jsPath, "utf8");
for (const sym of ["replay_commands", "roundtrip_snapshot", "view_model", "mitigator"]) {
  if (js.includes(sym)) {
    console.error(`FAIL: conformance symbol '${sym}' leaked into the default build`);
    process.exit(1);
  }
}
const wasm = readFileSync(wasmPath);
if (wasm.includes(Buffer.from("conformance:"))) {
  console.error("FAIL: a 'conformance:' registry key is baked into the default wasm build");
  process.exit(1);
}
console.log("OK: default build exposes no conformance symbols");
