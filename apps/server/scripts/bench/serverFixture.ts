// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- private child IPC, bootstrap descriptors and process retirement deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";

export async function makeFixture(threads: number) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-responsiveness-")),
  );
  try {
    return await startFixture(root, threads);
  } catch (error) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function startFixture(root: string, threads: number) {
  for (const directory of [
    "home",
    "tmp",
    "goat/userdata",
    "workspace",
    "config",
    "cache",
    "data",
  ]) {
    await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true, mode: 0o700 });
  }
  const workspace = NodePath.join(root, "workspace");
  const env: NodeJS.ProcessEnv = {
    PATH: [NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(NodePath.delimiter),
    HOME: NodePath.join(root, "home"),
    USERPROFILE: NodePath.join(root, "home"),
    TMPDIR: NodePath.join(root, "tmp"),
    TMP: NodePath.join(root, "tmp"),
    TEMP: NodePath.join(root, "tmp"),
    XDG_CONFIG_HOME: NodePath.join(root, "config"),
    XDG_CACHE_HOME: NodePath.join(root, "cache"),
    XDG_DATA_HOME: NodePath.join(root, "data"),
    GOAT_HOME: NodePath.join(root, "goat"),
    GOAT_TRACE_FILE: NodePath.join(root, "trace.ndjson"),
    GOAT_LOG_LEVEL: "Error",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const run = NodeUtil.promisify(NodeChildProcess.execFile);
  await run("git", ["init", "--quiet", workspace], { env });
  await NodeFSP.writeFile(
    NodePath.join(workspace, "fixture.txt"),
    "Generated responsiveness benchmark workspace\n",
  );
  await run("git", ["-C", workspace, "add", "fixture.txt"], { env });
  await run(
    "git",
    [
      "-C",
      workspace,
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Generated fixture",
    ],
    { env },
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "fixture.json"),
    JSON.stringify({ version: 1, root, threads, synthetic: true }),
    { mode: 0o600 },
  );
  const reservation = NodeNet.createServer();
  reservation.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No fixture port allocated");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const credential = NodeCrypto.randomBytes(32).toString("base64url");
  const child = NodeChildProcess.fork(
    NodeURL.fileURLToPath(new URL("../../src/bin.ts", import.meta.url)),
    ["serve", "--bootstrap-fd", "4", "--base-dir", NodePath.join(root, "goat")],
    {
      cwd: workspace,
      env,
      execArgv: [
        "--import",
        NodeURL.fileURLToPath(new URL("./benchmarkPreload.ts", import.meta.url)),
      ],
      stdio: ["pipe", "pipe", "pipe", "ipc", "pipe"],
    },
  );
  const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
  // The bootstrap channel stays private; neither credentials nor pairing output enter artifacts.
  const bootstrap = child.stdio[4] as NodeStream.Writable;
  bootstrap.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      host: "127.0.0.1",
      port,
      goatHome: NodePath.join(root, "goat"),
      desktopBootstrapToken: credential,
      shellEnvironmentPrepared: true,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }) + "\n",
  );
  let output = "";
  let diagnostic = "";
  child.stderr?.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-8000);
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture startup deadline exceeded")), 90_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
      if (output.includes("GOAT server is ready.")) finish();
    });
    child.once("error", finish);
    child.once("exit", (code, signal) =>
      finish(
        new Error(
          `Fixture exited before readiness: ${code ?? signal}; ${diagnostic.replaceAll(credential, "[credential]")}`,
        ),
      ),
    );
  });
  function receipt(type: string, command?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Missing fixture ${type} receipt`)), 90_000);
      const exited = () => finish(new Error(`Fixture exited awaiting ${type}`));
      const received = (value: unknown) => {
        if (typeof value === "object" && value !== null && "type" in value && value.type === type)
          finish(undefined, value);
      };
      function finish(error?: Error, value?: unknown) {
        clearTimeout(timer);
        child.off("message", received);
        child.off("exit", exited);
        if (error) reject(error);
        else resolve(value);
      }
      child.on("message", received);
      child.once("exit", exited);
      if (command)
        child.send(command, (error) => {
          if (error) finish(error);
        });
    });
  }
  const seeded = receipt("seeded");
  child.send({ root });
  return {
    root,
    child,
    credential,
    origin: `http://127.0.0.1:${port}`,
    receipt,
    ready: Promise.all([ready, seeded]).then(([, value]) => value),
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        let forced = false;
        const timer = setTimeout(() => {
          forced = true;
          child.kill("SIGKILL");
        }, 15_000);
        try {
          await exit;
        } finally {
          clearTimeout(timer);
        }
        if (forced)
          throw new Error("Fixture required forced termination; trace shutdown may be incomplete");
      } else {
        await exit;
      }
    },
    async remove() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}
