// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { guardChild } from "@goat/shared/errorGuards";
import { Observations, counter } from "./observations.ts";
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
    NodeFS.statSync(realDatabase).size === 0
  )
    throw new Error("missing or unsafe copied database");
  return supplied;
}

export type OwnedChild = {
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

export function spawnServer(
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
      "--log-level",
      "debug",
    ],
    { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

export async function waitForReady(server: OwnedChild): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    let buffer = "";
    const consume = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-65536);
      if (buffer.includes("Accepting commands")) resolve();
    };
    server.child.stdout?.on("data", consume);
    server.child.stderr?.on("data", consume);
  });
  await Promise.race([
    ready,
    server.failure,
    server.exited.then(({ code, signal }) => {
      throw new Error(`server exited before readiness: ${code ?? signal}`);
    }),
  ]);
}

export async function runSoak(options: SoakOptions, checkout: string): Promise<void> {
  validateHome(options.home, checkout);
  const reportParent = NodeFS.realpathSync(NodePath.dirname(options.report));
  const root = NodeFS.realpathSync(checkout);
  if (reportParent === root || reportParent.startsWith(`${root}${NodePath.sep}`))
    throw new Error("report must be outside checkout");
  const lifecycle = `${options.report}.provider-lifecycle.ndjson`;
  NodeFS.closeSync(NodeFS.openSync(lifecycle, "wx", 0o600));
  const owned: OwnedChild[] = [];
  let server: OwnedChild | undefined;
  let teardown = false;
  let serverExit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const errors: string[] = [];
  try {
    server = spawnServer(options, root, lifecycle, NodeCrypto.randomBytes(32).toString("hex"));
    owned.push(server);
    process.stdout.write(`owned server pid: ${server.child.pid}\n`);
    void server.exited.then(() => {
      if (!teardown) serverExit = true;
    });
    await waitForReady(server);
    const runtime = JSON.parse(
      NodeFS.readFileSync(NodePath.join(options.home, "userdata/server-runtime.json"), "utf8"),
    ) as { pid?: number; port?: number };
    if (runtime.pid !== server.child.pid || runtime.port !== options.serverPort)
      throw new Error("server runtime identity mismatch");
    for (let i = 0; i < 2 * NodeOS.availableParallelism(); i++) {
      const burner = spawnOwned(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("./burner.ts", import.meta.url))],
        { cwd: root, stdio: "ignore" },
      );
      owned.push(burner);
      process.stdout.write(`owned burner pid: ${burner.child.pid}\n`);
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.durationMs);
      }),
      server.failure,
      server.exited.then(() => {
        throw new Error("server exited during workload");
      }),
      ...owned.slice(1).map((child) =>
        Promise.race([
          child.failure,
          child.exited.then(() => {
            throw new Error("burner exited during workload");
          }),
        ]),
      ),
    ]);
  } catch (error) {
    errors.push(String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    teardown = true;
    await cleanupOwned(owned);
    const observations = new Observations();
    const report = {
      ...observations.report(
        [
          "client workload not connected",
          "provider lifecycle coverage unavailable",
          "stall coverage unavailable",
          "saturation unverified",
        ],
        counter(0, ["provider lifecycle coverage unavailable"]),
        counter(serverExit ? 1 : 0),
      ),
      home: options.home,
      serverPid: server?.child.pid ?? null,
      ownedPids: owned.map(({ child }) => child.pid),
      errors,
      artifacts: [lifecycle],
    };
    NodeFS.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

if (import.meta.main) {
  await runSoak(parseArgs(process.argv.slice(2)), process.cwd());
}
