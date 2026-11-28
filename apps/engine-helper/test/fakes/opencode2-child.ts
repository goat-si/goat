import { createServer } from "node:http";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const argsValid = process.argv.includes("fixture-arg") && process.argv.includes("serve") && process.argv.includes("--hostname=127.0.0.1") && portArg;
const password = process.env.OPENCODE_PASSWORD;
if (!argsValid || !password || password === "old-v2" || process.env.OPENCODE_SERVER_PASSWORD !== undefined) process.exit(2);
const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) { response.writeHead(401).end(); return; }
  if (request.url === "/api/info") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "2.3.4", pid: process.pid, urls: [], paths: { tmp: "/tmp" } }));
  } else if (request.url === "/api/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  } else response.writeHead(404).end();
});
server.listen(Number(portArg.slice("--port=".length)), "127.0.0.1", () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${portArg.slice("--port=".length)}\n`);
});
