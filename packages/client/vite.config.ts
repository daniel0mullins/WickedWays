import { defineConfig } from "vite";

// Vite resolves the workspace packages (`wickedways`, `@wickedways/transport-shared`)
// via their package.json `exports`, transpiling the engine's `.ts` source directly.
export default defineConfig({
  server: { port: 5173 },
});
