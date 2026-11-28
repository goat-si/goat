import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostSupervisor, groupAlive, killGroup, parseAnnounce, type HostPhase, type HostState } from "./hostSupervisor.ts";

const FAKE_HOST = fileURLToPath(new URL("./test-fixtures/fake-host.mjs", import.meta.url));

// A failing assertion skips that test's stop(); stop every supervisor at the end so leaked fake
// hosts never keep the test process alive.
const supervisors: HostSupervisor[] = [];
after(() => Promise.all(supervisors.map((supervisor) => supervisor.stop())).then(() => undefined));

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

/** killGroup that reports the group still alive (without touching it) the first time, then works. */
function survivesFirstKill(): (pgid: number, graceMs: number, killWaitMs?: number) => Promise<boolean> {
  let calls = 0;
  return (pgid, graceMs, killWaitMs) => (++calls === 1 ? Promise.resolve(false) : killGroup(pgid, graceMs, killWaitMs));
}


async function harness(
  mode: string,
  extra: Partial<ConstructorParameters<typeof HostSupervisor>[0]> = {},
  fakeEnv: Record<string, string> = {},
) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "goat2-desktop-test-"));
  const pidsFile = join(dir, "pids");
  const states: HostState[] = [];
  const supervisor = new HostSupervisor({
    command: process.execPath,
    args: [FAKE_HOST],
    env: { ...process.env, ...fakeEnv, GOAT2_HOST_PORT: String(port), FAKE_HOST_PIDS: pidsFile, FAKE_HOST_MODE: mode },
    healthUrl: (announce) => `http://127.0.0.1:${announce.port ?? port}/health`,
    healthIntervalMs: 20,
    stopGraceMs: 300,
    restartDelayMs: () => 50,
    onState: (state) => states.push(state),
    ...extra,
  });
  supervisors.push(supervisor);
  const pids = (role: string) =>
    existsSync(pidsFile)
      ? readFileSync(pidsFile, "utf8").trim().split("\n").filter((line) => line.startsWith(role + " ")).map((line) => Number(line.split(" ")[1]))
      : [];
  const phases = () => states.map((state) => state.phase);
  const reached = (phase: HostPhase) => until(() => supervisor.state.phase === phase);
  return { supervisor, pids, phases, reached, port, states };
}

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
  const h = await harness("grandchild,crash-after-ready");
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
  await h.supervisor.stop();
  for (const agent of h.pids("agent")) assert.equal(alive(agent), false);
});

test("a host that keeps dying pauses in crash-loop after v1's 5 restarts, and start() leaves the pause", async () => {
  const h = await harness("exit-now");
  h.supervisor.start();
  await h.reached("crash-loop");
  assert.equal(h.pids("host").length, 6, "first start + 5 restarts");
  assert.equal(h.supervisor.state.lastExit, "code=3");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.pids("host").length, 6, "no spawn during the pause");
  h.supervisor.start();
  await until(() => h.pids("host").length >= 7);
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
  const h = await harness("grandchild,crash-first-after-ready", { stopGraceMs: 600 });
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
    healthUrl: () => "http://127.0.0.1:9/health",
    restartDelayMs: () => 10,
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
  const h = await harness("exit-clean-after-ready");
  h.supervisor.start();
  await until(() => h.pids("host").length === 2);
  assert.equal(h.states.find((state) => state.lastExit === "code=0")?.phase, "restarting");
  await h.supervisor.stop();
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("ready needs both signals: /health 200 without a start line stays starting", async () => {
  const h = await harness("no-announce");
  h.supervisor.start();
  await settle(600);
  assert.equal(h.supervisor.state.phase, "starting");
  await h.supervisor.stop();
});

test("ready needs both signals: a start line with /health 503 or 204 stays starting", async () => {
  for (const status of ["503", "204"]) {
    const h = await harness("", {}, { FAKE_HOST_HEALTH_STATUS: status });
    h.supervisor.start();
    await until(() => h.supervisor.state.announce !== null);
    await settle(400);
    assert.equal(h.supervisor.state.phase, "starting", `/health ${status} counted as ready`);
    await h.supervisor.stop();
  }
});

test("ready comes with whichever signal arrives last, in either order", async () => {
  const healthFirst = await harness("", {}, { FAKE_HOST_ANNOUNCE_DELAY_MS: "400" });
  healthFirst.supervisor.start();
  await healthFirst.reached("ready");
  assert.notEqual(healthFirst.states.find((state) => state.phase === "ready")?.announce ?? null, null);
  await healthFirst.supervisor.stop();

  const announceFirst = await harness("", {}, { FAKE_HOST_HEALTH_DELAY_MS: "400" });
  announceFirst.supervisor.start();
  await until(() => announceFirst.supervisor.state.announce !== null);
  assert.equal(announceFirst.supervisor.state.phase, "starting");
  await announceFirst.reached("ready");
  await announceFirst.supervisor.stop();
});

test("a host that announced but never passed /health and exits 0 is not restarted", async () => {
  const h = await harness("exit-clean-after-ready", {}, { FAKE_HOST_HEALTH_STATUS: "503" });
  h.supervisor.start();
  await h.reached("exited");
  await settle(300);
  assert.equal(h.pids("host").length, 1);
  await h.supervisor.stop();
});

test("restart() replaces the host and its whole group, and is not a crash", async () => {
  const h = await harness("grandchild,ignore-term");
  h.supervisor.start();
  await h.reached("ready");
  await until(() => h.pids("agent").length === 1);
  const [oldHost] = h.pids("host");
  const [oldAgent] = h.pids("agent");
  assert.ok(oldHost !== undefined && oldAgent !== undefined);
  await h.supervisor.restart();
  await h.reached("ready");
  assert.equal(h.pids("host").length, 2);
  assert.equal(alive(oldHost), false);
  assert.equal(alive(oldAgent), false, "the old host's agent survived the restart");
  assert.equal(h.supervisor.state.restarts, 0);
  assert.equal(h.supervisor.state.lastExit, null, "the old host's exit was taken for a crash");
  await h.supervisor.stop();
});

+test("start() during restart() waits for the old group and starts exactly one new host", async () => {
  // The agent ignores SIGTERM, so ending the old group takes the full grace period.
  const h = await harness("grandchild,ignore-term", { stopGraceMs: 600 });
  h.supervisor.start();
  await h.reached("ready");
  await until(() => h.pids("agent").length === 1);
  const [oldHost] = h.pids("host");
  const [oldAgent] = h.pids("agent");
  assert.ok(oldHost !== undefined && oldAgent !== undefined);
  const restarting = h.supervisor.restart();
  // Menu "Start Host" pressed while the old group is still being ended.
  h.supervisor.start();
  await settle(100);
  assert.equal(h.pids("host").length, 1, "start() spawned a host before the old group was gone");
  await restarting;
  await h.reached("ready");
  assert.equal(alive(oldHost), false);
  assert.equal(alive(oldAgent), false);
  await settle(300);
  assert.equal(h.pids("host").length, 2, "restart() did not start exactly one replacement host");
  await h.supervisor.stop();
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false);
});

+test("restart() holds the replacement while the old group survives SIGKILL, then starts exactly one", async () => {
  const h = await harness("grandchild,ignore-term", { killGroup: survivesFirstKill(), stuckRetryMs: 150 });
  h.supervisor.start();
  await h.reached("ready");
  await until(() => h.pids("agent").length === 1);
  const [oldHost] = h.pids("host");
  assert.ok(oldHost !== undefined);
  const restarting = h.supervisor.restart();
  await h.reached("stuck");
  assert.equal(h.supervisor.state.stuckGroup, oldHost);
  h.supervisor.start();
  await settle(100);
  assert.equal(h.pids("host").length, 1, "a replacement started while the old group was still alive");
  assert.equal(alive(oldHost), true);
  await restarting;
  await h.reached("ready");
  assert.equal(alive(oldHost), false);
  assert.equal(h.supervisor.state.stuckGroup, null);
  await settle(200);
  assert.equal(h.pids("host").length, 2);
  await h.supervisor.stop();
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false);
});

test("crash recovery holds the restart while the crashed group survives SIGKILL", async () => {
  const h = await harness("grandchild,crash-first-after-ready", { killGroup: survivesFirstKill(), stuckRetryMs: 300 });
  h.supervisor.start();
  await h.reached("stuck");
  const [agent] = h.pids("agent");
  assert.ok(agent !== undefined);
  assert.equal(alive(agent), true);
  h.supervisor.start();
  await settle(150);
  assert.equal(h.pids("host").length, 1, "recovery or start() spawned beside a surviving group");
  await until(() => h.pids("host").length === 2);
  assert.equal(alive(agent), false);
  await h.reached("ready");
  await h.supervisor.stop();
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false);
});

+test("stop() returns when the host itself survives SIGKILL and never reports its exit", async () => {
  const h = await harness("grandchild,ignore-term", { killGroup: survivesFirstKill() });
  h.supervisor.start();
  await h.reached("ready");
  const [host] = h.pids("host");
  assert.ok(host !== undefined);
  const started = Date.now();
  await h.supervisor.stop();
  assert.ok(Date.now() - started < 4_000, "stop() waited for the exit of a host that survived SIGKILL");
  assert.equal(h.supervisor.state.phase, "stopped");
  // The simulated survivor is still alive; end it so the test leaves nothing behind.
  process.kill(-host, "SIGKILL");
});

test("stop() while an old group is stuck returns without waiting out the retry interval", async () => {
  const h = await harness("grandchild,ignore-term", { killGroup: survivesFirstKill(), stuckRetryMs: 60_000 });
  h.supervisor.start();
  await h.reached("ready");
  const [oldHost] = h.pids("host");
  assert.ok(oldHost !== undefined);
  void h.supervisor.restart();
  await h.reached("stuck");
  const started = Date.now();
  await h.supervisor.stop();
  assert.ok(Date.now() - started < 3_000, "stop() waited for the stuck-group retry");
  assert.equal(h.supervisor.state.phase, "stopped");
  assert.equal(h.pids("host").length, 1);
  // The simulated survivor is still alive; end it so the test leaves nothing behind.
  process.kill(-oldHost, "SIGKILL");
});

+test("restart() during a stuck crash cleanup keeps showing the stuck state", async () => {
  const h = await harness("grandchild,crash-first-after-ready", { killGroup: survivesFirstKill(), stuckRetryMs: 400 });
  h.supervisor.start();
  await h.reached("stuck");
  const stuckGroup = h.supervisor.state.stuckGroup;
  assert.notEqual(stuckGroup, null);
  const restarting = h.supervisor.restart();
  assert.equal(h.supervisor.state.phase, "stuck", "Restart Host hid the group that will not exit");
  assert.equal(h.supervisor.state.stuckGroup, stuckGroup);
  await settle(150);
  assert.equal(h.supervisor.state.phase, "stuck");
  assert.equal(h.pids("host").length, 1);
  await restarting;
  await h.reached("ready");
  assert.equal(h.supervisor.state.stuckGroup, null);
  await settle(200);
  assert.equal(h.pids("host").length, 2, "restart after a stuck cleanup did not start exactly one host");
  await h.supervisor.stop();
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false);
});

test("stop() during restart() ends the old group and starts nothing", async () => {
  const h = await harness("grandchild,ignore-term");
  h.supervisor.start();
  await h.reached("ready");
  await until(() => h.pids("agent").length === 1);
  const restarting = h.supervisor.restart();
  await h.supervisor.stop();
  // Quitting ends the work: when stop() returns, the old group must already be gone.
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false, "stop() returned before the old group was gone");
  await restarting;
  await settle(300);
  assert.equal(h.pids("host").length, 1);
  for (const pid of [...h.pids("host"), ...h.pids("agent")]) assert.equal(alive(pid), false);
  assert.equal(h.supervisor.state.phase, "stopped");
});

test("a /health redirect to a 200 page is not ready", async () => {
  const h = await harness("health-redirect");
  h.supervisor.start();
  await until(() => h.supervisor.state.announce !== null);
  await settle(400);
  assert.equal(h.supervisor.state.phase, "starting");
  await h.supervisor.stop();
});

test("a /health 200 seen before the start line is not carried over", async () => {
  // 200 for the first 150 ms, 503 after; the start line comes at 400 ms.
  const h = await harness("", {}, { FAKE_HOST_HEALTH_UNTIL_MS: "150", FAKE_HOST_ANNOUNCE_DELAY_MS: "400" });
  h.supervisor.start();
  await until(() => h.supervisor.state.announce !== null);
  await settle(400);
  assert.equal(h.supervisor.state.phase, "starting");
  await h.supervisor.stop();
});
