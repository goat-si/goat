#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- A local live check: it owns an X server, a bus and a fixture.
// @effect-diagnostics globalTimers:off -- Waits for processes it started.
// @effect-diagnostics preferSchemaOverJson:off
// Live smoke for the Linux computer use helper (WS10 #1138): starts a private Xvfb display, a
// private D-Bus session with AT-SPI and the GOAT fixture window, then drives a packaged helper
// through observe, act, observe, private mode and stop, and checks nothing it started is left.
// Every process is stopped by the pid it was started with; the person's desktop is never used.
//
//   node scripts/build-computer-use-helper-linux.ts --out /tmp/gcu
//   node scripts/computer-use-linux-smoke.ts --helper /tmp/gcu/goat-computer-use --evidence /tmp/gcu-evidence [--xvfb /path/to/Xvfb]
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";

import {
  admitComputerUseReply,
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseHelloReply,
  negotiateComputerUseVersion,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const { values } = NodeUtil.parseArgs({
  options: {
    helper: { type: "string" },
    evidence: { type: "string", default: "computer-use-linux-evidence" },
    xvfb: { type: "string", default: "Xvfb" },
  },
});
if (!values.helper) throw new Error("--helper <path to goat-computer-use> is required.");
const evidence = NodePath.resolve(values.evidence);
await NodeFSP.mkdir(evidence, { recursive: true });
const fixture = NodePath.resolve(
  import.meta.dirname,
  "../apps/server/src/cua/linuxHelper/fixtures/goat-cu-fixture.py",
);

const started: NodeChildProcess.ChildProcess[] = [];
const transcript: Array<Record<string, unknown>> = [];
const log = (step: string, detail: Record<string, unknown>) => {
  transcript.push({ step, ...detail });
  process.stdout.write(step + " " + JSON.stringify(detail) + "\n");
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const start = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: NodeChildProcess.StdioOptions = "ignore",
) => {
  const child = NodeChildProcess.spawn(command, args, { env, stdio });
  started.push(child);
  return child;
};
/** Child pids of one process, from /proc; the helper's driver is found this way. */
const children = async (pid: number) => {
  const tasks = await NodeFSP.readdir("/proc/" + pid + "/task").catch(() => []);
  const pids: number[] = [];
  for (const task of tasks) {
    const text = await NodeFSP.readFile(
      "/proc/" + pid + "/task/" + task + "/children",
      "utf8",
    ).catch(() => "");
    pids.push(...text.split(/\s+/u).filter(Boolean).map(Number));
  }
  return pids;
};

let failed = false;
const check = (name: string, ok: boolean, detail: Record<string, unknown> = {}) => {
  log((ok ? "PASS " : "FAIL ") + name, detail);
  if (!ok) failed = true;
};

try {
  // -displayfd: Xvfb picks a free display itself and writes its number once it is listening,
  // so this run never lands on a display someone else owns.
  const xvfb = start(
    values.xvfb,
    ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
    process.env,
    ["ignore", "ignore", "ignore", "pipe"],
  );
  const displayOutput = xvfb.stdio[3];
  if (!displayOutput || !("on" in displayOutput)) throw new Error("Xvfb has no display pipe.");
  const display = await Promise.race([
    new Promise<string>((resolve) =>
      NodeReadline.createInterface({ input: displayOutput }).once("line", (line) =>
        resolve(":" + line.trim()),
      ),
    ),
    new Promise<never>((_, reject) =>
      xvfb.once("exit", (code) => reject(new Error("Xvfb exited with " + code + "."))),
    ),
    sleep(10_000).then(() => {
      throw new Error("Xvfb did not report a display.");
    }),
  ]);
  const dbus = start("dbus-daemon", ["--session", "--nofork", "--print-address=1"], process.env, [
    "ignore",
    "pipe",
    "ignore",
  ]);
  const busOutput = dbus.stdout;
  if (!busOutput) throw new Error("dbus-daemon has no stdout.");
  const address = await new Promise<string>((resolve) =>
    NodeReadline.createInterface({ input: busOutput }).once("line", (line) => resolve(line.trim())),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    DISPLAY: display,
    DBUS_SESSION_BUS_ADDRESS: address,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    GTK_A11Y: "atspi",
  };
  start("/usr/libexec/at-spi-bus-launcher", ["--launch-immediately"], env);
  await sleep(800);
  const app = start("python3", [fixture], env, ["ignore", "pipe", "ignore"]);
  await sleep(2000);
  log("environment", { xvfb: xvfb.pid, dbus: dbus.pid, fixture: app.pid, display });

  const helper = NodeChildProcess.spawn(values.helper, [], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  started.push(helper);
  const { stdin: toHelper, stdout: fromHelper, pid: helperPid } = helper;
  if (!toHelper || !fromHelper || helperPid === undefined)
    throw new Error("The helper did not start.");
  const replies = NodeReadline.createInterface({ input: fromHelper });
  const queue: string[] = [];
  const waiters: Array<() => void> = [];
  replies.on("line", (line) => {
    queue.push(line);
    waiters.splice(0).forEach((wake) => wake());
  });
  const next = async () => {
    while (queue.length === 0) await new Promise<void>((wake) => waiters.push(wake));
    return queue.shift() ?? "";
  };
  toHelper.write(JSON.stringify({ clientApiVersion: COMPUTER_USE_PROTOCOL_VERSION }) + "\n");
  const hello = Schema.decodeUnknownSync(Schema.fromJsonString(ComputerUseHelloReply))(
    await next(),
  );
  if (!("binding" in hello)) throw new Error("helper refused: " + hello.message);
  check(
    "hello binds the spawned process",
    hello.binding.pid === helperPid && negotiateComputerUseVersion(hello.serverApiVersion) === true,
    { binding: hello.binding, maxFrameBytes: hello.maxFrameBytes },
  );
  const generation = hello.binding.generation;
  const pending = new Set<string>();
  let serial = 0;
  const request = async (method: string, params: unknown = {}) => {
    const id = String(++serial);
    pending.add(id);
    const t0 = performance.now();
    toHelper.write(JSON.stringify({ id, generation, method, deadlineMs: 20_000, params }) + "\n");
    const line = await next();
    const reply = JSON.parse(line) as {
      id: string;
      generation: string;
      result: any;
      image?: { mimeType: string; data: string };
    };
    const admitted = admitComputerUseReply({
      reply,
      frameBytes: Buffer.byteLength(line),
      maxFrameBytes: hello.maxFrameBytes,
      generation,
      pending,
    });
    pending.delete(id);
    if (admitted !== "deliver") throw new Error("reply " + id + " was " + admitted);
    return { ...reply, ms: Math.round(performance.now() - t0) };
  };
  const saveImage = async (name: string, image: { data: string } | undefined) => {
    if (!image) return undefined;
    const file = NodePath.join(evidence, name);
    await NodeFSP.writeFile(file, Buffer.from(image.data, "base64"));
    return file;
  };

  const capabilities = await request("capabilities");
  check(
    "capabilities name every method",
    Object.keys(capabilities.result.methods).length === 13,
    capabilities.result,
  );
  const permissions = await request("permissions");
  check(
    "readiness: a real tree and a non-blank capture are proven, on X11",
    permissions.result.tree === "ready" &&
      permissions.result.capture === "ready" &&
      permissions.result.helper === "authenticated" &&
      permissions.result.platform?.linux?.displayServer === "x11",
    permissions.result,
  );
  const windows = await request("listWindows");
  const window = windows.result.windows.find((entry: any) => entry.title === "GOAT CU Fixture");
  check("listWindows finds the fixture by its own pid", window?.pid === app.pid, {
    windows: windows.result.windows,
  });
  const target = { pid: window.pid, windowId: window.windowId };

  const first = await request("observe", { target, screenshot: true });
  const elements = first.result.elements as Array<any>;
  const ref = (label: string) => elements.find((element) => element.label === label)?.ref;
  check(
    "first observation is full with a screenshot beside it",
    first.result.kind === "full" &&
      first.image !== undefined &&
      !JSON.stringify(first.result).includes(first.image?.data ?? "-"),
    {
      ms: first.ms,
      elements: elements.map((element) => [
        element.ref,
        element.role,
        element.label,
        element.value,
      ]),
      screenshot: first.result.screenshot,
      file: await saveImage("1-before.png", first.image),
    },
  );

  const click = await request("click", {
    action: "click",
    target: first.result.target,
    observationId: first.result.observationId,
    delivery: "background",
    at: { element: ref("Increment") },
  });
  const counter = click.result.observation?.changed?.find(
    (element: any) => element.label === "Count",
  );
  check(
    // The counter changed, not the clicked button, so the helper shows the change without
    // claiming it: unverifiable, with the diff for the agent to judge.
    "background AT-SPI click lands; its diff shows the counter, unclaimed",
    click.result.outcome === "unverifiable" && counter?.value === "1",
    {
      ms: click.ms,
      result: {
        ...click.result,
        observation: {
          kind: click.result.observation?.kind,
          changed: click.result.observation?.changed,
        },
      },
      file: await saveImage("2-after-click.png", click.image),
    },
  );

  const stale = await request("click", {
    action: "click",
    target: first.result.target,
    observationId: first.result.observationId,
    delivery: "background",
    at: { element: ref("Increment") },
  });
  check(
    "acting on the observation before the click is staleElement",
    stale.result.outcome === "refused" && stale.result.reason === "staleElement",
    stale.result,
  );

  const latest = click.result.observation;
  const set = await request("setValue", {
    action: "setValue",
    target: latest.target,
    observationId: latest.observationId,
    delivery: "background",
    element: ref("Name"),
    value: "GOAT on Linux",
  });
  check("setValue through AT-SPI is confirmed", set.result.outcome === "confirmed", {
    ms: set.ms,
    outcome: set.result.outcome,
    dispatch: set.result.dispatch,
    detail: set.result.detail,
    file: await saveImage("3-after-set-value.png", set.image),
  });

  const keys = await request("pressKey", {
    action: "pressKey",
    target: latest.target,
    observationId: set.result.observation.observationId,
    delivery: "background",
    key: "a",
  });
  check(
    "background keys without uinput are refused, not faked",
    keys.result.outcome === "refused" && keys.result.reason === "backgroundUnavailable",
    keys.result,
  );

  // Give the fixture window X input focus (no window manager runs here), then focus the password.
  const xdotool = NodeChildProcess.spawnSync(
    "xdotool",
    ["search", "--name", "GOAT CU Fixture", "windowfocus", "--sync"],
    { env, timeout: 5000 },
  );
  app.kill("SIGUSR1");
  await sleep(500);
  const secret = await request("observe", {
    target,
    screenshot: true,
    since: set.result.observation.observationId,
  });
  check(
    "a focused password field starts private mode: no tree, no screenshot",
    secret.result.privateMode === true &&
      secret.image === undefined &&
      secret.result.elements?.length === 0,
    { xdotool: xdotool.status, result: secret.result },
  );
  const blocked = await request("click", {
    action: "click",
    target: secret.result.target,
    observationId: secret.result.observationId,
    delivery: "background",
    at: { element: ref("Increment") },
  });
  check(
    "actions during private mode are refused with privateMode",
    blocked.result.outcome === "refused" && blocked.result.reason === "privateMode",
    blocked.result,
  );

  const driverPids = await children(helperPid);
  const exited = new Promise<number | null>((resolve) =>
    helper.once("exit", (code) => resolve(code)),
  );
  toHelper.end();
  const code = await Promise.race([exited, sleep(10_000).then(() => "timeout" as const)]);
  await sleep(300);
  check(
    "closing stdin stops the helper and its driver",
    code === 0 && driverPids.length > 0 && driverPids.every((pid) => !alive(pid)),
    { code, driverPids, alive: driverPids.filter(alive) },
  );
} catch (error) {
  failed = true;
  log("FAIL exception", { message: error instanceof Error ? error.stack : String(error) });
} finally {
  for (const child of started.toReversed())
    if (child.pid !== undefined && child.exitCode === null) child.kill("SIGTERM");
  await sleep(500);
  const left = started.filter((child) => child.pid !== undefined && alive(child.pid));
  log("cleanup", { left: left.map((child) => child.pid) });
  await NodeFSP.writeFile(
    NodePath.join(evidence, "transcript.json"),
    JSON.stringify(transcript, null, 2) + "\n",
  );
}
process.exit(failed ? 1 : 0);
