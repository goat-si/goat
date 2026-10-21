import * as HostProcess from "@goat/shared/HostProcess";
import { ChildProcess } from "effect/process";

/**
 * JavaScript for a fixture server spawned directly by a test: exit once stdin
 * ends. The test worker holds the other end of that pipe, so this fires when
 * the worker dies or times out before its scope finalizers run, which
 * otherwise leaves the server running under PID 1. Servers that the launch
 * script starts get `</dev/null` and must not use this.
 */
export const exitWithTestParent = (condition: string) =>
  `if (${condition}) { process.stdin.once("end", () => process.exit(0)); process.stdin.once("error", () => process.exit(0)); process.stdin.resume(); }`;

/** Where a fixture records the test worker that owns the servers it starts. */
export const TEST_OWNER_FILE = "owner-pid";

/**
 * JavaScript for a fixture server the launch script starts. Its stdin is `/dev/null` and it
 * outlives the shell on purpose, so it watches instead: it exits once the test worker named in
 * `<fixtureDir>/owner-pid` is gone or the fixture directory was removed. Without this, a worker
 * killed before its scope finalizers leaves the server running under PID 1.
 */
export const exitWithTestOwner = (fixtureDir: string) =>
  `{ const ownerFs = require("node:fs"); const ownerDir = ${fixtureDir};
  const ownerFile = require("node:path").join(ownerDir, ${JSON.stringify(TEST_OWNER_FILE)});
  const owner = ownerFs.existsSync(ownerFile) ? Number(ownerFs.readFileSync(ownerFile, "utf8")) : 0;
  setInterval(() => {
    let alive = ownerFs.existsSync(ownerDir);
    if (alive && owner > 0) { try { process.kill(owner, 0); } catch (error) { alive = error.code === "EPERM"; } }
    if (!alive) process.exit(0);
  }, 500).unref(); }`;

/**
 * Runs a fixture shell command so its process group dies with the test worker.
 *
 * Fixture shells park on FIFO reads (lock barriers, race gates) and their runners outlive
 * the shell on purpose. The spawner gives each command its own process group and kills it
 * when the scope closes, but a worker that is killed or times out never closes the scope,
 * and a parked `read` never sees a hangup, so the group would stay under PID 1 indefinitely.
 * A watcher inside the group kills the group once the worker is gone. Being a member keeps
 * the group ID from being reused, so the kill can only reach this command's processes.
 */
export const killGroupWithTestOwner = (
  command: ChildProcess.Command,
  ownerPid: number = process.pid,
): ChildProcess.Command => {
  if (command._tag !== "StandardCommand" || HostProcess.Platform.defaultValue() === "win32")
    return command;
  const watcher = `(while kill -0 ${ownerPid} 2>/dev/null; do /bin/sleep 1; done; kill -KILL 0) </dev/null >/dev/null 2>&1 &`;
  return ChildProcess.make(
    "/bin/sh",
    ["-c", `${watcher} exec "$0" "$@"`, command.command, ...command.args],
    command.options,
  );
};
