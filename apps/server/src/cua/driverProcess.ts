// @effect-diagnostics nodeBuiltinImport:off -- The lease proxy owns its driver child process outside Effect's process abstractions.
import * as NodeChildProcess from "node:child_process";

/**
 * The lease proxy's driver child. On POSIX it gets a process group of its own, so a stop reaches
 * what it started: the computer use helper runs the driver as its grandchild (ADR-0023
 * per-session isolation), and only this connection's pair ends.
 */
export function spawnDriverProcess(
  platform: NodeJS.Platform,
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  /** A fourth descriptor, fd 3, for the macOS helper's cursor overlay channel (#1214). */
  overlay = false,
) {
  const child = NodeChildProcess.spawn(command, [...args], {
    env,
    stdio: overlay ? ["pipe", "pipe", "inherit", "pipe"] : ["pipe", "pipe", "inherit"],
    windowsHide: true,
    detached: platform !== "win32",
  });
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  // A leader that dies alone (a helper launcher crash) is not this side's to clean up: once Node
  // has reaped it, its group id may name another process group. The helper's service watches its
  // launcher and ends the driver itself.
  return child;
}

/**
 * Signals the driver's whole process group on POSIX, where it was started detached. Only while
 * the leader is unreaped: until Node reaps it (which happens in the event loop, never during this
 * call) its PID, and so the group id, cannot be reused.
 */
export function killDriverGroup(
  platform: NodeJS.Platform,
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32" || child.pid === undefined) return void child.kill(signal);
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Ends every live driver group when the proxy itself is told to stop or exits: a detached group
 * would otherwise outlive the proxy that enforces its lease, and a driver reads the end of its
 * input only between calls.
 */
export function endDriversWithProxy(
  platform: NodeJS.Platform,
  live: () => Iterable<NodeChildProcess.ChildProcess>,
) {
  const endAll = () => {
    for (const child of live()) killDriverGroup(platform, child, "SIGKILL");
  };
  process.once("exit", endAll);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    process.once(signal, () => {
      endAll();
      process.exit(code);
    });
}
