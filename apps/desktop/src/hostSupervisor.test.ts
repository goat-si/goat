import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostSupervisor, groupAlive, parseAnnounce, restartDelayMs, type HostPhase, type HostState } from "./hostSupervisor.ts";

const FAKE_HOST = fileURLToPath(new URL("./test-fixtures/fake-host.mjs", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function harness(mode: string, extra: Partial<ConstructorParameters<typeof HostSupervisor>[0]> = {}) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "goat2-desktop-test-"));
  const pidsFile = join(dir, "pids");
  const states: HostState[] = [];
  const supervisor = new HostSupervisor({
    command: process.execPath,
    args: [FAKE_HOST],
    env: { ...process.env, GOAT2_HOST_PORT: String(port), FAKE_HOST_PIDS: pidsFile, FAKE_HOST_MODE: mode },
    healthUrl: `http://127.0.0.1:${port}/health`,
    healthIntervalMs: 20,
    stopGraceMs: 300,
    restartDelayMs: () => 50,
    onState: (state) => states.push(state),
    ...extra,
  });
  const pids = (role: string) =>
    existsSync(pidsFile)
      ? readFileSync(pidsFile, "utf8").trim().split("\n").filter((line) => line.startsWith(role + " ")).map((line) => Number(line.split(" ")[1]))
      : [];
  const phases = () => states.map((state) => state.phase);
  const reached = (phase: HostPhase) => until(() => supervisor.state.phase === phase);
  return { supervisor, pids, phases, reached, port, states };
}

test("v1 backoff: jittered, doubling, capped at 30 s", () => {
  assert.equal(restartDelayMs(0, 0), 500);
  assert.equal(restartDelayMs(0, 1), 1_000);
  assert.equal(restartDelayMs(3, 1), 8_000);
  assert.equal(restartDelayMs(9, 1), 30_000);
  assert.equal(restartDelayMs(9, 0), 15_000);
});

test("start line: only a JSON object with wsUrl counts", () => {
  assert.equal(parseAnnounce("booting"), null);
  assert.equal(parseAnnounce('{"port":1}'), null);
  assert.deepEqual(parseAnnounce('{"wsUrl":"ws://127.0.0.1:1/ws","mcpUrl":"http://x","port":1,"generation":2}'), {
    wsUrl: "ws://127.0.0.1:1/ws",
    mcpUrl: "http://x",
    port: 1,
    generation: 2,
  });
});

test("ready after /health, start line recorded, stop kills the whole group including an agent that ignores SIGTERM", async () => {
  const h = await harness("grandchild,ignore-term");
  h.supervisor.start();
  await h.reached("ready");
  await until(() => h.supervisor.state.announce !== null);
  assert.equal(h.supervisor.state.announce?.wsUrl, `ws://127.0.0.1:${h.port}/ws`);
  await until(() => h.pids("agent").length === 1);
  const [host] = h.pids("host");
  const [agent] = h.pids("agent");
  assert.ok(host !== undefined && agent !== undefined);
  assert.ok(alive(host) && alive(agent));
  await h.supervisor.stop();
  assert.equal(h.supervisor.state.phase, "stopped");
  assert.equal(groupAlive(host), false);
  assert.equal(alive(agent), false, "agent in the host's group survived quit");
  assert.deepEqual(h.phases().slice(-2), ["stopping", "stopped"]);
});

test("a crashed host's leftover agents are killed, then the host restarts", async () => {
  const h = await harness("grandchild,crash-after-ready", { maxRestarts: 1 });
  h.supervisor.start();
  await until(() => h.pids("host").length === 2);
  const [firstHost, secondHost] = h.pids("host");
  const [firstAgent] = h.pids("agent");
  assert.ok(firstHost !== undefined && secondHost !== undefined && firstAgent !== undefined);
  assert.notEqual(firstHost, secondHost);
  assert.equal(alive(firstAgent), false, "orphaned agent from the crashed host still running");
  assert.ok(h.phases().includes("restarting"));
  const atExit = h.states.find((state) => state.lastExit === "code=1");
  assert.equal(atExit?.phase, "restarting", "host shown as up while its leftover group was being cleaned");
  assert.equal(h.supervisor.state.lastExit, "code=1");
  await h.reached("crash-loop");
  await h.supervisor.stop();
  for (const agent of h.pids("agent")) assert.equal(alive(agent), false);
});

test("a host that keeps dying pauses in crash-loop after maxRestarts, and start() leaves the pause", async () => {
  const h = await harness("exit-now", { maxRestarts: 3 });
  h.supervisor.start();
  await h.reached("crash-loop");
  assert.equal(h.pids("host").length, 4, "first start + 3 restarts");
  assert.equal(h.supervisor.state.lastExit, "code=3");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.pids("host").length, 4, "no spawn during the pause");
  h.supervisor.start();
  await until(() => h.pids("host").length >= 5);
  await h.supervisor.stop();
});

test("stop() during the restart wait does not start another host", async () => {
  const h = await harness("exit-now", { restartDelayMs: () => 300 });
  h.supervisor.start();
  await h.reached("restarting");
  await h.supervisor.stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.pids("host").length, 1);
  assert.equal(h.supervisor.state.phase, "stopped");
});

test("start() while a crashed host's group is being cleaned does not start a second host", async () => {
  // The agent ignores SIGTERM, so cleanup of the crashed group takes the full grace period.
  const h = await harness("grandchild,crash-after-ready", { stopGraceMs: 600, maxRestarts: 1 });
  h.supervisor.start();
  await until(() => h.supervisor.state.lastExit === "code=1");
  h.supervisor.start();
  h.supervisor.start();
  await until(() => h.pids("host").length === 2);
  // Outlast the crashed group's cleanup (600 ms grace) plus the 50 ms restart delay.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(h.pids("host").length, 2, "manual start raced recovery into an extra host");
  await h.supervisor.stop();
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false);
});

test("a missing binary is a crash, not a thrown error", async () => {
  const supervisor = new HostSupervisor({
    command: "/nonexistent/goat2-host",
    env: {},
    healthUrl: "http://127.0.0.1:9/health",
    restartDelayMs: () => 10,
    maxRestarts: 1,
  });
  supervisor.start();
  await until(() => supervisor.state.phase === "crash-loop");
  assert.match(supervisor.state.lastExit ?? "", /ENOENT/);
  await supervisor.stop();
});

test("a host that exits 0 before it was ever ready (the empty stub) is not restarted", async () => {
  const h = await harness("exit-clean");
  h.supervisor.start();
  await h.reached("exited");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.pids("host").length, 1);
  assert.equal(h.supervisor.state.lastExit, "code=0");
  assert.ok(!h.phases().includes("restarting"));
  h.supervisor.start();
  await until(() => h.pids("host").length === 2);
  await h.reached("exited");
  await h.supervisor.stop();
});

test("a host that was ready and then exits 0 is still restarted", async () => {
  const h = await harness("exit-clean-after-ready", { maxRestarts: 1 });
  h.supervisor.start();
  await until(() => h.pids("host").length === 2);
  assert.equal(h.states.find((state) => state.lastExit === "code=0")?.phase, "restarting");
  await h.supervisor.stop();
});
