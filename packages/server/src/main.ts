import { createServer } from "./server.js";
import { SqliteStore } from "./sqlite-store.js";
import { buildSeedRegistry, demoGenesis } from "@wickedways/seed";

const port = Number(process.env.PORT ?? 8787);
const registry = buildSeedRegistry();
const dbPath = process.env.DB_PATH; // unset ⇒ ephemeral (today's behavior)
const store = dbPath === undefined ? undefined : new SqliteStore(dbPath);
void createServer({
  port,
  verifyToken: (t) => t || null,
  gmIdentityFor: (_id) => process.env.GM_IDENTITY ?? "gm",
  registry,
  genesisFor: (id) => (id === "demo" ? demoGenesis() : null),
  store,
}).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}${store ? ` (persisting to ${dbPath})` : ""}`);
});
