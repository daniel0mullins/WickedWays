import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
void createServer({ port, verifyToken: (t) => t || null, gmIdentityFor: (_id) => process.env.GM_IDENTITY ?? "gm" }).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}`);
});
