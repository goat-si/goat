// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { guardChild, guardErrors } from "@goat/shared/errorGuards";
import {
  Observations,
  counter,
  LogTail,
  DetailWriter,
  cpuBusy,
  saturation,
  providerRestarts,
} from "./observations.ts";
import { runWorkload } from "./clients.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type SoakOptions = {
  home: string;
  report: string;
  serverPort: number;
  projectId?: string;
  replayThreads: number;
  headlessClients: number;
  codexThreads: number;
  durationMs: number;
};

export function parseArgs(argv: string[]): SoakOptions {
  const values = new Map<string, string>();
  const known = new Set([
    "home",
    "report",
    "server-port",
    "project-id",
    "replay-threads",
    "headless-clients",
    "codex-threads",
    "duration-ms",
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (
      !key?.startsWith("--") ||
      !known.has(key.slice(2)) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(key.slice(2))
    )
      throw new Error(`invalid argument: ${key ?? ""}`);
    values.set(key.slice(2), value);
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`missing --${key}`);
    return value;
  };
  const integer = (key: string, defaultValue: number, min: number, max: number) => {
    const raw = values.get(key) ?? String(defaultValue);
    if (!/^\d+$/.test(raw)) throw new Error(`invalid --${key}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`invalid --${key}`);
    return value;
  };
  const port = required("server-port");
  const home = required("home");
  const report = required("report");
  if (!NodePath.isAbsolute(home) || !NodePath.isAbsolute(report))
    throw new Error("home and report must be absolute");
  return {
    home,
    report,
    serverPort: integer("server-port", Number(port), 1, 65535),
    ...(values.has("project-id") ? { projectId: required("project-id") } : {}),
    replayThreads: integer("replay-threads", 120, 1, 10000),
    headlessClients: integer("headless-clients", 20, 1, 1000),
    codexThreads: integer("codex-threads", 2, 1, 1000),
    durationMs: integer("duration-ms", 1800000, 1, 86400000),
  };
}

export function validateHome(home: string, checkout: string): string {
  const root = NodeFS.realpathSync(checkout);
  const supplied = NodePath.resolve(home);
  if (supplied !== NodePath.join(root, ".goat") && supplied !== NodePath.join(root, ".t3"))
    throw new Error("home must be the checkout's isolated .goat or .t3");
  if (NodeFS.realpathSync(supplied) !== supplied)
    throw new Error("home is a symlink or escapes checkout");
  const database = NodePath.join(supplied, "userdata", "statev2.sqlite");
  const realDatabase = NodeFS.realpathSync(database);
  if (
    !realDatabase.startsWith(`${supplied}${NodePath.sep}`) ||
    !NodeFS.statSync(realDatabase).isFile() ||
    NodeFS.statSync(realDatabase).nlink !== 1 ||
    NodeFS.statSync(realDatabase).size === 0
  )
    throw new Error("missing or unsafe copied database");
  return supplied;
}

type OwnedChild = {
  child: NodeChildProcess.ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  failure: Promise<never>;
};

function spawnOwned(
  command: string,
  args: string[],
  options: NodeChildProcess.SpawnOptions,
): OwnedChild {
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});
  const child = guardChild(NodeChildProcess.spawn(command, args, options), rejectFailure);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return { child, exited, failure };
}

export async function cleanupOwned(children: OwnedChild[]): Promise<void> {
  for (const { child } of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.all(children.map(({ exited }) => exited));
}

function spawnServer(
  options: SoakOptions,
  checkout: string,
  lifecyclePath: string,
  credential: string,
): OwnedChild {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GOAT_DEV_AUTH_TOKEN: credential,
    GOAT_TELEMETRY_ENABLED: "false",
    GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: lifecyclePath,
  };
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  delete env.GOAT_SERVICE_LAUNCHER_CONTEXT;
  delete env.GOAT_BOOT_SERVICE_UNIT;
  return spawnOwned(
    process.execPath,
    [
      NodePath.join(checkout, "apps/server/src/bin.ts"),
      "start",
      "--base-dir",
      options.home,
      "--port",
      String(options.serverPort),
      "--host",
      "127.0.0.1",
      "--dev-url",
      `http://127.0.0.1:${options.serverPort}`,
      "--no-browser",
    ],
    { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function waitForReady(server: OwnedChild, directory: string, port: number): Promise<void> {
  let watcher: NodeFS.FSWatcher | undefined;
  let readinessTimer: ReturnType<typeof setInterval> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const check = () => {
      try {
        if (verifyRuntimeState(directory, server.child.pid, port)) resolve();
      } catch {
        // A previous server's runtime file may still exist until publication.
      }
    };
    watcher = guardErrors(NodeFS.watch(directory, check), reject);
    readinessTimer = setInterval(check, 250);
    check();
  });
  try {
    await Promise.race([
      ready,
      server.failure,
      server.exited.then(({ code, signal }) => {
        throw new Error(`server exited before readiness: ${code ?? signal}`);
      }),
    ]);
  } finally {
    if (readinessTimer !== undefined) clearInterval(readinessTimer);
    watcher?.close();
  }
}

export function verifyRuntimeState(
  directory: string,
  pid: number | undefined,
  port: number,
): boolean {
  let contents: string;
  try {
    contents = NodeFS.readFileSync(NodePath.join(directory, "server-runtime.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const runtime = JSON.parse(contents) as { pid?: number; port?: number };
  if (runtime.pid !== pid || runtime.port !== port)
    throw new Error("server runtime identity mismatch");
  return true;
}

async function runSoak(options: SoakOptions, checkout: string): Promise<void> {
  validateHome(options.home, checkout);
  const reportParent = NodeFS.realpathSync(NodePath.dirname(options.report));
  const root = NodeFS.realpathSync(checkout);
  if (reportParent === root || reportParent.startsWith(`${root}${NodePath.sep}`))
    throw new Error("report must be outside checkout");
  const reportFd = NodeFS.openSync(options.report, "wx", 0o600);
  const lifecycle = `${options.report}.provider-lifecycle.ndjson`;
  const detailPath = `${options.report}.detail.ndjson`;
  const owned: OwnedChild[] = [];
  const burners: OwnedChild[] = [];
  const observations = new Observations();
  let server: OwnedChild | undefined;
  let serverExit = false;
  let runtimeConfirmed = false;
  let teardown = false;
  let stoppingBurners = false;
  let workload:
    | Promise<{
        replayStarted: number;
        codexStarted: number;
        headlessOpened: number;
        sessionOpened: number;
      }>
    | undefined;
  let workloadResult: Awaited<NonNullable<typeof workload>> | undefined;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  const abort = new AbortController();
  const credential = NodeCrypto.randomBytes(32).toString("hex");
  const errors: string[] = [];
  let detail: DetailWriter | undefined;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let cpuTimer: ReturnType<typeof setInterval> | undefined;
  let previousCpu: ReturnType<typeof NodeOS.cpus> | undefined;
  let previousCpuAt = 0;
  const cpuSamples: Array<{ at: string; perCore: number[]; busy: number }> = [];
  const cpuGaps: string[] = [];
  const sampleCpu = () => {
    const now = Date.now();
    const cpus = NodeOS.cpus();
    if (previousCpu) {
      if (now - previousCpuAt > 7500) cpuGaps.push("CPU sampling interval exceeded 7.5 seconds");
      const perCore = cpuBusy(
        previousCpu.map((cpu) => cpu.times),
        cpus.map((cpu) => cpu.times),
      );
      const busy = perCore.reduce((sum, value) => sum + value, 0) / perCore.length;
      cpuSamples.push({ at: new Date(now).toISOString(), perCore, busy });
    }
    previousCpu = cpus;
    previousCpuAt = now;
  };
  try {
    NodeFS.closeSync(NodeFS.openSync(lifecycle, "wx", 0o600));
    detail = new DetailWriter(detailPath);
    const stallPath = NodePath.join(options.home, "userdata/logs/event-loop-stalls.ndjson");
    const tracePath = NodePath.join(options.home, "userdata/logs/server.trace.ndjson");
    const stall = new LogTail(stallPath, (value) => {
      observations.consumeStall(value);
      detail?.write({ source: "stall", value });
    });
    const trace = new LogTail(tracePath, (value) => {
      observations.consumeTrace(value);
    });
    const provider = new LogTail(lifecycle, (value) => {
      observations.consumeLifecycle(value);
      detail?.write({ source: "provider", value });
    });
    if (NodeFS.existsSync(stallPath)) stall.startAtEnd();
    if (NodeFS.existsSync(tracePath)) trace.startAtEnd();
    const sample = () => {
      try {
        provider.read();
        if (NodeFS.existsSync(stallPath)) stall.read();
        if (NodeFS.existsSync(tracePath)) trace.read();
      } catch (error) {
        observations.gap(`telemetry failed: ${String(error)}`);
      }
    };
    sampleTimer = setInterval(sample, 5000);
    server = spawnServer(options, root, lifecycle, credential);
    owned.push(server);
    server.child.stdout?.resume();
    server.child.stderr?.resume();
    process.stdout.write(`owned server pid: ${server.child.pid}\n`);
    void server.exited.then(() => {
      if (!teardown) serverExit = true;
    });
    await waitForReady(server, NodePath.join(options.home, "userdata"), options.serverPort);
    runtimeConfirmed = verifyRuntimeState(
      NodePath.join(options.home, "userdata"),
      server.child.pid,
      options.serverPort,
    );
    let rejectBurner: (error: Error) => void = () => {};
    const burnerFailure = new Promise<never>((_, reject) => {
      rejectBurner = reject;
    });
    void burnerFailure.catch(() => {});
    workload = runWorkload({
      origin: `http://127.0.0.1:${options.serverPort}`,
      credential,
      checkout: root,
      artifactPrefix: options.report,
      lifecyclePath: lifecycle,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      replayThreads: options.replayThreads,
      codexThreads: options.codexThreads,
      headlessClients: options.headlessClients,
      durationMs: options.durationMs,
      observations,
      recordDetail: (value) => {
        try {
          detail?.write(value);
        } catch (error) {
          observations.gap(`detail write failed: ${String(error)}`);
        }
      },
      signal: abort.signal,
      onWindowStart: () => {
        startedAt = new Date().toISOString();
        observations.setWindowOpen(true);
        for (let i = 0; i < 2 * NodeOS.availableParallelism(); i++) {
          const burner = spawnOwned(
            process.execPath,
            [NodeURL.fileURLToPath(new URL("./burner.ts", import.meta.url))],
            { cwd: root, stdio: "ignore" },
          );
          burners.push(burner);
          owned.push(burner);
          process.stdout.write(`owned burner pid: ${burner.child.pid}\n`);
          void burner.failure.catch(rejectBurner);
          void burner.exited.then(() => {
            if (!stoppingBurners && !teardown)
              rejectBurner(new Error("burner exited during workload"));
          });
        }
        sampleCpu();
        cpuTimer = setInterval(sampleCpu, 5000);
      },
      onWindowEnd: async () => {
        if (cpuTimer !== undefined) clearInterval(cpuTimer);
        sampleCpu();
        endedAt = new Date().toISOString();
        observations.setWindowOpen(false);
        stoppingBurners = true;
        await cleanupOwned(burners);
        progressTimer = setInterval(
          () => process.stdout.write("Waiting for issued turns to drain\n"),
          30_000,
        );
      },
    });
    workloadResult = await Promise.race([
      workload,
      server.failure,
      burnerFailure,
      server.exited.then(() => {
        throw new Error("server exited during workload");
      }),
    ]);
    if (
      !verifyRuntimeState(
        NodePath.join(options.home, "userdata"),
        server.child.pid,
        options.serverPort,
      )
    )
      throw new Error("server runtime identity was not published");
    runtimeConfirmed = true;
    sample();
    for (const gap of [...stall.gaps, ...trace.gaps, ...provider.gaps]) observations.gap(gap);
    if (stall.hasPartialLine || trace.hasPartialLine || provider.hasPartialLine)
      observations.gap("partial telemetry line");
  } catch (error) {
    errors.push(String(error).replaceAll(credential, "[redacted]"));
  } finally {
    teardown = true;
    if (sampleTimer !== undefined) clearInterval(sampleTimer);
    if (cpuTimer !== undefined) clearInterval(cpuTimer);
    if (progressTimer !== undefined) clearInterval(progressTimer);
    abort.abort();
    await cleanupOwned(owned);
    if (workload) await workload.catch(() => {});
    detail?.close();
    const cpu = saturation(cpuSamples, cpuGaps);
    const provider = providerRestarts(
      observations.lifecycle,
      observations.joins,
      observations.releases,
      observations.deaths,
      [
        "provider forced-exit coverage test not performed",
        ...(observations.lifecycle.some(
          (line) => line.instance === "devReplay" && line.event === "start",
        )
          ? []
          : ["no Replay lifecycle start observed"]),
        ...(observations.lifecycle.some(
          (line) => line.instance !== "devReplay" && line.event === "start",
        )
          ? []
          : ["no Codex lifecycle start observed"]),
        ...observations.gaps,
      ],
    );
    const report = {
      ...observations.report(
        [
          "client-runtime session coverage lacks a forced disconnect test",
          ...(!cpu.verified ? ["saturation unverified"] : []),
          ...(errors.length ? ["workload error"] : []),
        ],
        provider.counter,
        counter(
          serverExit ? 1 : 0,
          runtimeConfirmed ? [] : ["server runtime identity unavailable"],
        ),
      ),
      home: options.home,
      serverPid: server?.child.pid ?? null,
      ownedPids: owned.map(({ child }) => child.pid),
      window: { start: startedAt, end: endedAt },
      saturation: cpu,
      providerRestartParts: provider,
      workload: {
        ...workloadResult,
        clientRuntimeCoverage: "session",
        replayRequested: options.replayThreads,
        codexRequested: options.codexThreads,
        headlessRequested: options.headlessClients,
        burnersStarted: burners.length,
        burnersRequested: 2 * NodeOS.availableParallelism(),
      },
      errors,
      artifacts: [
        lifecycle,
        detailPath,
        `${options.report}.codex-script.json`,
        `${lifecycle}.codex-turns`,
      ].filter((path) => NodeFS.existsSync(path)),
    };
    NodeFS.writeSync(reportFd, `${JSON.stringify(report, null, 2)}\n`);
    NodeFS.closeSync(reportFd);
  }
}

if (import.meta.main) {
  await runSoak(parseArgs(process.argv.slice(2)), process.cwd());
}
