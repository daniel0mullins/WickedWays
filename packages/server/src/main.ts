import { createServer } from "./server.js";
import { buildSeedRegistry, demoGenesis } from "@wickedways/seed";

const port = Number(process.env.PORT ?? 8787);
const registry = buildSeedRegistry();
void createServer({
  port,
  verifyToken: (t) => t || null,
  gmIdentityFor: (_id) => process.env.GM_IDENTITY ?? "gm",
  registry,
  genesisFor: (id) => (id === "demo" ? demoGenesis() : null),
}).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}`);
});
