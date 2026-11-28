// Fake goat2-host for hostSupervisor tests. Behaviour comes from env:
//   GOAT2_HOST_PORT   port for GET /health (and the start line)
//   FAKE_HOST_PIDS    file the host appends "<role> <pid>" lines to
//   FAKE_HOST_MODE    comma list: crash-after-ready, exit-clean-after-ready, exit-now, exit-clean,
//                     ignore-term, grandchild
//   FAKE_HOST_ANNOUNCE_DELAY_MS  print the start line this late (slow host start)
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const modes = new Set((process.env.FAKE_HOST_MODE ?? "").split(",").filter(Boolean));
const port = Number(process.env.GOAT2_HOST_PORT);
const record = (role, pid) => {
  if (process.env.FAKE_HOST_PIDS) appendFileSync(process.env.FAKE_HOST_PIDS, `${role} ${pid}\n`);
};
record("host", process.pid);
if (modes.has("exit-now")) process.exit(3);
if (modes.has("exit-clean")) process.exit(0);
if (modes.has("ignore-term")) process.on("SIGTERM", () => {});
if (modes.has("grandchild")) {
  // Stands in for a codex app-server the host started: same group, ignores SIGTERM.
  const agent = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  record("agent", agent.pid);
}
const server = createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404).end();
});
server.listen(port, "127.0.0.1", () => {
  console.log("booting");
  const announce = () => console.log(JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ws`, mcpUrl: null, port, generation: 1 }));
  setTimeout(announce, Number(process.env.FAKE_HOST_ANNOUNCE_DELAY_MS ?? 0));
  if (modes.has("crash-after-ready")) setTimeout(() => process.exit(1), 300);
  if (modes.has("exit-clean-after-ready")) setTimeout(() => process.exit(0), 300);
});
