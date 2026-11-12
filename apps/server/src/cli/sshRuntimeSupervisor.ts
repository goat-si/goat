// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import { guardChild } from "@goat/shared/errorGuards";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  encodePowerShellCommand,
  WINDOWS_DETACHED_SPAWN_POWERSHELL,
} from "@goat/shared/windowsHostProcess";
import type { RuntimeProtocolVerdict } from "@goat/shared/sshRuntimeProtocol";
import {
  SSH_REPLACEMENT_ID_ENV,
  sshReplacementOwner,
  sshSupervisorOwner,
} from "../serverOwnerLock.ts";
import { tryAcquireServerOwnerLock } from "../serverOwnerLockFile.ts";
import { processExists, readSshRuntimeCompatibility } from "./sshRuntimeProbes.ts";
import { serverWorkingDirectory } from "./serverWorkingDirectory.ts";

/**
 * The supervisor's record of the last replacement it ran, in the launch state directory it
 * already owns. The runtime reads it to skip a target that failed or rolled back.
 */
export const SSH_REPLACEMENT_RECORD_FILE = "last-replacement.json";
const SshReplacementRecord = Schema.Struct({
  status: Schema.Literals(["replaced", "rolled-back", "failed"]),
  targetVersion: Schema.String,
  previousVersion: Schema.String,
  at: Schema.String,
});
const SshReplacementRecordJson = Schema.fromJsonString(SshReplacementRecord);
const decodeSshReplacementRecord = Schema.decodeUnknownOption(SshReplacementRecordJson);
const encodeSshReplacementRecord = Schema.encodeSync(SshReplacementRecordJson);
export const readSshReplacementRecord = (text: string) =>
  Option.getOrUndefined(decodeSshReplacementRecord(text.trim()));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForExit = async (pid: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
};

const DATABASE_SUFFIXES = ["", "-wal", "-shm"] as const;

const copyDatabase = (fromDir: string, toDir: string) => {
  NodeFS.mkdirSync(toDir, { recursive: true, mode: 0o700 });
  for (const suffix of DATABASE_SUFFIXES) {
    const source = NodePath.join(fromDir, `statev2.sqlite${suffix}`);
    const target = NodePath.join(toDir, `statev2.sqlite${suffix}`);
    if (NodeFS.existsSync(source)) NodeFS.copyFileSync(source, target);
    else NodeFS.rmSync(target, { force: true });
  }
};

const writeAtomically = (file: string, contents: string, mode = 0o600) => {
  const next = `${file}.next.${process.pid}`;
  // Removing first and creating exclusively means a link planted at this name is never followed.
  NodeFS.rmSync(next, { force: true });
  NodeFS.writeFileSync(next, contents, { mode, flag: "wx" });
  NodeFS.renameSync(next, file);
};

// After a forced stop another server may answer on the port; only the runtime record the child
// writes for this base directory proves the answer came from it.
const recordsChild = (baseDir: string, pid: number, port: number) => {
  try {
    const record: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
    );
    return (
      typeof record === "object" &&
      record !== null &&
      "pid" in record &&
      record.pid === pid &&
      "port" in record &&
      record.port === port
    );
  } catch {
    return false;
  }
};

// Runs after a runtime is ready and recorded: a leftover file is logged and never changes the result.
const cleanUpAfterStart = (path: string) => {
  try {
    NodeFS.rmSync(path, { recursive: true, force: true });
  } catch (cause) {
    process.stderr.write(
      `Replacement supervisor could not remove ${path}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }
};

/**
 * The start time a launch records for a forced stop to compare, as `ps -o lstart=` prints it in
 * UTC, and on Linux the start tick from /proc; undefined where neither can be read.
 */
const launchStart = (pid: number) => {
  const ps = NodeChildProcess.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const started = ps.status === 0 ? ps.stdout.trim().replace(/\s+/gu, " ") : "";
  if (started === "") return undefined;
  let ticks = "-";
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? "-";
  } catch {
    // No /proc on this host: the start time alone is recorded.
  }
  return { started, ticks };
};

const writeLaunchRecords = (
  stateDir: string,
  identity: string,
  pid: number,
  port: number,
  platform: NodeJS.Platform | undefined,
) => {
  for (const [name, contents] of [
    ["identity", `${identity}\n`],
    ["pid", `${pid}\n`],
    ["port", `${port}\n`],
    ["managed", "managed\n"],
  ] as const)
    writeAtomically(NodePath.join(stateDir, name), contents);
  const start = platform === "win32" ? undefined : launchStart(pid);
  if (start === undefined) {
    for (const name of ["started", "started.ticks"])
      NodeFS.rmSync(NodePath.join(stateDir, name), { force: true });
    return;
  }
  writeAtomically(NodePath.join(stateDir, "started"), `${start.started}\n`);
  writeAtomically(NodePath.join(stateDir, "started.ticks"), `${start.ticks}\n`);
};

const restoreRunner = (input: SshRuntimeSupervisorInput) => {
  NodeFS.copyFileSync(input.previousRunnerFile, `${input.runnerFile}.restore`);
  NodeFS.chmodSync(`${input.runnerFile}.restore`, 0o700);
  NodeFS.renameSync(`${input.runnerFile}.restore`, input.runnerFile);
  if (NodePath.basename(input.runnerFile) === "run-t3.sh") {
    const alias = NodePath.join(NodePath.dirname(input.runnerFile), "run-goat.sh");
    const next = `${alias}.next.${process.pid}`;
    try {
      NodeFS.rmSync(next, { force: true });
      try {
        NodeFS.linkSync(input.runnerFile, next);
      } catch {
        NodeFS.copyFileSync(input.runnerFile, next);
        NodeFS.chmodSync(next, 0o700);
      }
      NodeFS.renameSync(next, alias);
    } catch {
      // The alias is cosmetic; a later launch can repair it.
    } finally {
      try {
        NodeFS.rmSync(next, { force: true });
      } catch {
        // Alias cleanup cannot invalidate the restored runner.
      }
    }
  }
};

export interface SshRuntimeSupervisorInput {
  /** The drained server. The supervisor never signals it; it waits for it to exit. */
  readonly oldPid: number;
  readonly oldInstanceId: string;
  readonly port: number;
  readonly baseDir: string;
  readonly stateDir: string;
  /** Published runner for `targetVersion`, and a private copy of the one it replaced. */
  readonly runnerFile: string;
  /** Empty with previousVersion: a forced stop left no earlier runtime that can be started again. */
  readonly previousRunnerFile: string;
  readonly targetVersion: string;
  readonly previousVersion: string;
  /** Launch identities recorded for the ownership checks, as the launch script writes them. */
  readonly identity: string;
  readonly previousIdentity: string;
  /**
   * The old server was stopped by a person's approved forced update, not drained. It predates
   * instance ids, so starting it again is proven by its version and protocol answer alone.
   */
  readonly forced?: boolean | undefined;
  /**
   * The launch stopped the old server itself and saw it exit. Its PID may already name another
   * process, so the supervisor neither waits on that number nor reads anything from it.
   */
  readonly oldStopped?: boolean | undefined;
  /**
   * On a Windows host, the release executables behind `runnerFile` and `previousRunnerFile`:
   * the runners are shell scripts there, and Windows starts the executable itself.
   */
  readonly executable?: string | undefined;
  readonly previousExecutable?: string | undefined;
  /** The host's platform; Windows starts replacements outside the SSH session's job. */
  readonly platform?: NodeJS.Platform | undefined;
  readonly exitTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly logFile: string;
}

export type SshRuntimeSupervisorResult =
  | { readonly status: "replaced" | "rolled-back"; readonly pid: number; readonly version: string }
  | { readonly status: "old-alive" | "failed"; readonly reason: string }
  /** A server it started failed and did not exit after SIGKILL; it was left running. */
  | {
      readonly status: "stuck";
      readonly pid: number;
      /** The version that process was started as: the target, or the previous one on rollback. */
      readonly version: string;
      readonly reason: string;
    };

/**
 * Starts a program outside the SSH session's job object, which Windows OpenSSH terminates with
 * the session, and returns its PID. See {@link WINDOWS_DETACHED_SPAWN_POWERSHELL}.
 */
const spawnWindowsDetached = (
  argv: ReadonlyArray<string>,
  logFile: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
) => {
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellCommand(WINDOWS_DETACHED_SPAWN_POWERSHELL),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GOAT_SPAWN_ARGS: argv.join("\n"),
        GOAT_SPAWN_LOG: logFile,
        GOAT_SPAWN_CWD: cwd,
        GOAT_SPAWN_ENV: Object.entries(env)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
      },
    },
  );
  const pid = Number.parseInt(result.stdout?.trim() ?? "", 10);
  return result.status === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Swaps the drained server for `targetVersion` on the same port. It runs detached from the SSH
 * session, so a dropped client cannot leave the host without a server. The new server must pass
 * the handshake: its descriptor names `targetVersion`, a new instance, and protocol ranges this
 * build attaches to. Otherwise the supervisor stops only the child it started, restores the
 * database and runner it backed up, and starts the previous version again.
 *
 * The backup and the restore both run under server-owner.lock. The restore is skipped when any
 * server other than this supervisor and the replacement it started owned the data since the
 * backup, so another server's writes are never overwritten by the snapshot.
 */
export const superviseSshRuntimeReplacement = async (
  input: SshRuntimeSupervisorInput,
): Promise<SshRuntimeSupervisorResult> => {
  let result: SshRuntimeSupervisorResult;
  try {
    result = await superviseReplacement(input);
  } catch (cause) {
    result = {
      status: "failed",
      reason: cause instanceof Error ? cause.message : "Replacement supervisor failed.",
    };
  }
  if (result.status !== "old-alive") {
    try {
      writeAtomically(
        NodePath.join(input.stateDir, SSH_REPLACEMENT_RECORD_FILE),
        encodeSshReplacementRecord({
          status: result.status === "stuck" ? "failed" : result.status,
          targetVersion: input.targetVersion,
          previousVersion: input.previousVersion,
          at: new Date().toISOString(),
        }) + "\n",
      );
    } catch (cause) {
      // The replacement result stands; without the record the runtime may retry this target.
      process.stderr.write(
        `Could not record the replacement outcome: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
  }
  return result;
};

const stuck = (pid: number, version: string): SshRuntimeSupervisorResult => ({
  status: "stuck",
  pid,
  version,
  reason: `GOAT ${version} (pid ${pid}) did not become ready and did not exit after SIGKILL; it was left running and nothing was restored.`,
});

const superviseReplacement = async (
  input: SshRuntimeSupervisorInput,
): Promise<SshRuntimeSupervisorResult> => {
  if (input.oldStopped !== true && !(await waitForExit(input.oldPid, input.exitTimeoutMs))) {
    // The drained server still owns the data, so it stays the recorded runtime and is never
    // signalled. The draining marker keeps launches from starting a second server beside it.
    if (input.previousVersion) {
      restoreRunner(input);
      NodeFS.rmSync(input.previousRunnerFile, { force: true });
    }
    writeLaunchRecords(
      input.stateDir,
      input.previousIdentity,
      input.oldPid,
      input.port,
      input.platform,
    );
    return {
      status: "old-alive",
      reason: `The drained GOAT ${input.previousVersion} (pid ${input.oldPid}) did not exit; it was left running.`,
    };
  }
  const userdata = NodePath.join(input.baseDir, "userdata");
  const backup = NodePath.join(input.stateDir, "replacement-backup");
  const replacementId = NodeCrypto.randomUUID();
  const ours = new Set([sshSupervisorOwner(replacementId), sshReplacementOwner(replacementId)]);
  NodeFS.mkdirSync(userdata, { recursive: true, mode: 0o700 });
  const backupLock = tryAcquireServerOwnerLock(userdata, sshSupervisorOwner(replacementId));
  if (backupLock === undefined)
    return {
      status: "failed",
      reason: `Another GOAT server is using ${userdata}; GOAT ${input.targetVersion} was not started.`,
    };
  const backupGeneration = backupLock.generation;
  try {
    copyDatabase(userdata, backup);
  } finally {
    backupLock.release();
  }

  const start = async (
    runner: string,
    executable: string | undefined,
    version: string,
    identity: string,
    accepts: (verdict: RuntimeProtocolVerdict) => boolean,
    extraEnv: Record<string, string> = {},
    requireInstance = true,
  ) => {
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--base-dir",
      input.baseDir,
    ];
    const env = { GOAT_NO_BROWSER: "1", GOAT_RUNTIME_ORIGIN: "ssh", ...extraEnv };
    let pid: number | undefined;
    // On POSIX the child handle signals only that process: once Node reaps it, kill does nothing.
    let child: NodeChildProcess.ChildProcess | undefined;
    try {
      if (input.platform === "win32") {
        pid =
          executable === undefined
            ? undefined
            : spawnWindowsDetached(
                [executable, ...args],
                input.logFile,
                env,
                serverWorkingDirectory(process.env.USERPROFILE ?? "", input.baseDir),
              );
      } else {
        const log = NodeFS.openSync(input.logFile, "a");
        try {
          const started = Promise.withResolvers<boolean>();
          child = guardChild(
            NodeChildProcess.spawn(runner, args, {
              cwd: serverWorkingDirectory(NodeOS.homedir()),
              detached: true,
              stdio: ["ignore", log, log],
              env: { ...process.env, ...env },
            }),
            () => started.resolve(false),
          );
          child.once("spawn", () => started.resolve(true));
          const spawned = await started.promise;
          if (spawned) {
            child.unref();
            pid = child.pid;
          }
        } finally {
          NodeFS.closeSync(log);
        }
      }
    } catch {
      return undefined;
    }
    if (pid === undefined) return undefined;
    const own = child;
    const exited = () =>
      own === undefined ? !processExists(pid) : own.exitCode !== null || own.signalCode !== null;
    const exitWithin = (ms: number) =>
      own === undefined
        ? waitForExit(pid, ms)
        : new Promise<boolean>((resolve) => {
            if (exited()) return resolve(true);
            const onExit = () => {
              clearTimeout(timer);
              resolve(true);
            };
            const timer = setTimeout(() => {
              own.off("exit", onExit);
              resolve(exited());
            }, ms);
            own.once("exit", onExit);
          });
    const signal = (name: NodeJS.Signals) =>
      own === undefined ? process.kill(pid, name) : own.kill(name);
    const deadline = Date.now() + input.readyTimeoutMs;
    while (Date.now() < deadline && !exited()) {
      try {
        const value = await readSshRuntimeCompatibility(input.port);
        if (
          value.serverVersion === version &&
          accepts(value.verdict) &&
          (requireInstance
            ? value.instanceId !== undefined &&
              value.instanceId !== input.oldInstanceId &&
              (input.oldStopped !== true || recordsChild(input.baseDir, pid, input.port))
            : input.oldStopped === true
              ? recordsChild(input.baseDir, pid, input.port)
              : !processExists(input.oldPid))
        ) {
          writeLaunchRecords(input.stateDir, identity, pid, input.port, input.platform);
          return pid;
        }
      } catch {
        // Not answering yet.
      }
      await delay(100);
    }
    // Only the child this supervisor started is ever signalled.
    if (!exited()) {
      signal("SIGTERM");
      if (!(await exitWithin(5000))) signal("SIGKILL");
      if (!(await exitWithin(5000))) return { stuck: pid };
    }
    return undefined;
  };

  const started = await start(
    input.runnerFile,
    input.executable,
    input.targetVersion,
    input.identity,
    (verdict) => verdict === "compatible",
    { [SSH_REPLACEMENT_ID_ENV]: replacementId },
  );
  if (typeof started === "object") return stuck(started.stuck, input.targetVersion);
  if (started !== undefined) {
    cleanUpAfterStart(backup);
    if (input.previousRunnerFile) cleanUpAfterStart(input.previousRunnerFile);
    return { status: "replaced", pid: started, version: input.targetVersion };
  }
  const restoreLock = tryAcquireServerOwnerLock(userdata, sshSupervisorOwner(replacementId));
  if (restoreLock === undefined)
    return {
      status: "failed",
      reason: `GOAT ${input.targetVersion} did not start and another GOAT server is now using ${userdata}; its database was left as is.`,
    };
  try {
    if (restoreLock.ownersSince(backupGeneration).every((owner) => ours.has(owner)))
      copyDatabase(backup, userdata);
  } finally {
    restoreLock.release();
  }
  if (!input.previousVersion)
    return {
      status: "failed",
      reason: `GOAT ${input.targetVersion} did not start, and no earlier runtime could be started again.`,
    };
  restoreRunner(input);
  // The previous version served this host before the swap. After an incompatible replacement
  // it does not speak this build's protocol, so it must only prove it is that version, freshly
  // started, advertising protocol ranges of its own.
  const restored = await start(
    input.runnerFile,
    input.previousExecutable,
    input.previousVersion,
    input.previousIdentity,
    (verdict) => verdict !== "unknown",
    {},
    input.forced !== true,
  );
  if (typeof restored === "object") return stuck(restored.stuck, input.previousVersion);
  if (restored === undefined)
    return {
      status: "failed",
      reason: `GOAT ${input.targetVersion} and the previous ${input.previousVersion} both failed to start.`,
    };
  cleanUpAfterStart(backup);
  cleanUpAfterStart(input.previousRunnerFile);
  return { status: "rolled-back", pid: restored, version: input.previousVersion };
};

export const supervise = Command.make("supervise", {
  oldPid: Flag.Int("old-pid"),
  oldInstanceId: Flag.String("old-instance-id"),
  port: Flag.Int("port"),
  baseDir: Flag.String("base-dir"),
  stateDir: Flag.String("state-dir"),
  runnerFile: Flag.String("runner"),
  previousRunnerFile: Flag.String("previous-runner").pipe(Flag.withDefault("")),
  targetVersion: Flag.String("target-version"),
  previousVersion: Flag.String("previous-version").pipe(Flag.withDefault("")),
  identity: Flag.String("identity"),
  previousIdentity: Flag.String("previous-identity").pipe(Flag.withDefault("")),
  forced: Flag.Boolean("forced"),
  oldStopped: Flag.Boolean("old-stopped"),
  executable: Flag.String("executable").pipe(Flag.optional),
  previousExecutable: Flag.String("previous-executable").pipe(Flag.optional),
  exitTimeoutMs: Flag.Int("exit-timeout-ms").pipe(Flag.withDefault(60_000)),
  readyTimeoutMs: Flag.Int("ready-timeout-ms").pipe(Flag.withDefault(60_000)),
  logFile: Flag.String("log"),
  resultFile: Flag.String("result"),
}).pipe(
  Command.withHandler(({ resultFile, executable, previousExecutable, ...input }) =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(async () => {
        let result: SshRuntimeSupervisorResult;
        try {
          result = await superviseSshRuntimeReplacement({
            ...input,
            executable: Option.getOrUndefined(executable),
            previousExecutable: Option.getOrUndefined(previousExecutable),
            platform,
          });
        } catch (cause) {
          result = {
            status: "failed",
            reason: cause instanceof Error ? cause.message : "Replacement supervisor failed.",
          };
        }
        const line = `${result.status} ${"pid" in result ? result.pid : 0} ${"version" in result ? result.version : "-"}\n`;
        try {
          writeAtomically(resultFile, line);
        } catch (cause) {
          // The launch then reports an unknown outcome; the log keeps the real one.
          process.stderr.write(
            `Replacement supervisor could not record its result (${line.trim()}): ${cause instanceof Error ? cause.message : String(cause)}\n`,
          );
        }
        if ("reason" in result) process.stderr.write(result.reason + "\n");
        process.stdout.write(line);
      }),
    ),
  ),
);
