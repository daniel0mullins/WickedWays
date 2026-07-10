import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  server: { port: 5174 },
  plugins: [wasm(), topLevelAwait()],
  build: { target: "esnext" },
});
