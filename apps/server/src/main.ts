// GOAT 2 engine host. Runs as its own process (never inside Electron main) so the app can restart
// without killing agent runs. Node 26 runs .ts directly (type stripping).
//
// Storage rule: no transcript copy. The DB keeps bots, run pointers, summaries, evidence and
// RuntimeStamps only; transcripts are read on demand from each CLI's native session log.
import { createServer } from "node:http";
import { listDrivers } from "./drivers.ts";

const port = Number(process.env.GOAT2_PORT ?? 5734);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, drivers: listDrivers() }));
    return;
  }
  res.writeHead(404).end();
}).listen(port, "127.0.0.1", () => {
  console.log(`goat2 server on http://127.0.0.1:${port}`);
});
