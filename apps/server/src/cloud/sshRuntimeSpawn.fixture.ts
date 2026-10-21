// @effect-diagnostics nodeBuiltinImport:off - Isolated CLI fixture for native process ordering.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Runtime from "./sshRuntimeAutoUpdate.ts";
import { defaultWindowsGitBash } from "./sshRuntimeGitBash.ts";

const [api, mode] = process.argv.slice(2);
if (
  (api !== "run" && api !== "runDetached") ||
  !["missing", "normal", "nonzero", "cancel"].includes(mode ?? "")
) {
  throw new Error("Expected host operation and fixture mode");
}
const platform = HostProcess.Platform.defaultValue();
const host = await Effect.runPromise(
  Runtime.SshRuntimeHost.pipe(Effect.provide(Runtime.layerHost)),
);
const shell = platform === "win32" ? await Effect.runPromise(defaultWindowsGitBash()) : "/bin/sh";
if (shell === undefined) throw new Error("Git Bash is required for native Windows checks");
const env = { ...process.env };
const root = NodeOS.tmpdir();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function cancellation() {
  const ready = Promise.withResolvers<{ socket: NodeNet.Socket; pid: number }>();
  const closed = Promise.withResolvers<void>();
  let socket: NodeNet.Socket | undefined;
  const server = NodeNet.createServer((connection) => {
    socket = connection;
    connection.on("error", (error) => {
      if (!("code" in error) || error.code !== "ECONNRESET") ready.reject(error);
    });
    connection.once("close", () => closed.resolve());
    connection.once("data", (data) =>
      ready.resolve({ socket: connection, pid: Number(data.toString()) }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  const script = `
    const socket = require('node:net').connect(${address.port}, '127.0.0.1');
    socket.on('connect', () => socket.write(String(process.pid)));
    socket.once('data', () => socket.end('finished'));
    socket.on('end', () => process.exit(0));
    socket.on('error', () => process.exit(1));
  `;
  const command =
    api === "run"
      ? host.run({ command: process.execPath, args: ["-e", script], env, timeoutMs: 30_000 })
      : host.runDetached({
          shell: shell!,
          script: 'exec "$@"\n',
          args: [process.execPath.replaceAll("\\", "/"), "-e", script],
          env,
          cwd: root,
        });
  const fiber = Effect.runFork(command);
  try {
    const child = await ready.promise;
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0)
      throw new Error("Expected owned command PID");
    await Effect.runPromise(Fiber.interrupt(fiber));
    const aliveAfterInterrupt = alive(child.pid);
    if (api === "runDetached") {
      const response = new Promise<string>((resolve) =>
        child.socket.once("data", (data) => resolve(data.toString())),
      );
      child.socket.write("finish");
      if ((await response) !== "finished")
        throw new Error("Detached command did not answer after interruption");
    }
    await closed.promise;
    return { interrupted: true, aliveAfterInterrupt, connectionClosed: true };
  } finally {
    socket?.end("finish");
    await Effect.runPromise(Fiber.interrupt(fiber));
    await server[Symbol.asyncDispose]();
  }
}

function exercise() {
  if (mode === "cancel") return cancellation();
  const missing = NodePath.join(root, "no-such-runtime-command");
  const code = mode === "nonzero" ? 7 : 0;
  return Effect.runPromise(
    api === "run"
      ? host.run({
          command: mode === "missing" ? missing : process.execPath,
          args:
            mode === "missing"
              ? []
              : [
                  "-e",
                  `process.stdout.write('out');process.stderr.write('err');process.exitCode=${code}`,
                ],
          env,
          timeoutMs: 30_000,
        })
      : host.runDetached({
          shell: mode === "missing" ? missing : shell!,
          script: `printf out; printf err >&2; exit ${code}\n`,
          args: [],
          env,
          cwd: root,
        }),
  );
}

// Observe without catching: a missing spawn listener must still crash this isolated process.
process.on("uncaughtExceptionMonitor", (error) => console.error("UNHANDLED", error));
// A fresh macrotask exposes nextTick-before-Promise ordering; this is not a timed delay.
NodeTimers.setImmediate(() => {
  void exercise().then(
    (result) => console.log("RESULT=" + JSON.stringify({ platform, api, mode, result })),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
});
