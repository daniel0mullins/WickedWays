import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
void createServer({ port, verifyToken: (t) => t || null }).then((h) => {
  console.log(`Wicked Ways room server listening on ws://127.0.0.1:${h.port}`);
});
