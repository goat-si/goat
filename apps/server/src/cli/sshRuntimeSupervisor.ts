// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

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
  NodeFS.writeFileSync(next, contents, { mode });
  NodeFS.renameSync(next, file);
};

const writeLaunchRecords = (stateDir: string, identity: string, pid: number, port: number) => {
  for (const [name, contents] of [
    ["identity", `${identity}\n`],
    ["pid", `${pid}\n`],
    ["port", `${port}\n`],
    ["managed", "managed\n"],
  ] as const)
    writeAtomically(NodePath.join(stateDir, name), contents);
};

const restoreRunner = (input: SshRuntimeSupervisorInput) => {
  NodeFS.copyFileSync(input.previousRunnerFile, `${input.runnerFile}.restore`);
  NodeFS.chmodSync(`${input.runnerFile}.restore`, 0o700);
  NodeFS.renameSync(`${input.runnerFile}.restore`, input.runnerFile);
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
  readonly previousRunnerFile: string;
  readonly targetVersion: string;
  readonly previousVersion: string;
  /** Launch identities recorded for the ownership checks, as the launch script writes them. */
  readonly identity: string;
  readonly previousIdentity: string;
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
  | { readonly status: "old-alive" | "failed"; readonly reason: string };

/**
 * Starts a program outside the SSH session's job object, which Windows OpenSSH terminates with
 * the session, and returns its PID. See {@link WINDOWS_DETACHED_SPAWN_POWERSHELL}.
 */
const spawnWindowsDetached = (
  argv: ReadonlyArray<string>,
  logFile: string,
  env: Readonly<Record<string, string>>,
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
          status: result.status,
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

const superviseReplacement = async (
  input: SshRuntimeSupervisorInput,
): Promise<SshRuntimeSupervisorResult> => {
  if (!(await waitForExit(input.oldPid, input.exitTimeoutMs))) {
    // The drained server still owns the data, so it stays the recorded runtime and is never
    // signalled. The draining marker keeps launches from starting a second server beside it.
    restoreRunner(input);
    NodeFS.rmSync(input.previousRunnerFile, { force: true });
    writeLaunchRecords(input.stateDir, input.previousIdentity, input.oldPid, input.port);
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
    const env = { GOAT_NO_BROWSER: "1", ...extraEnv };
    let pid: number | undefined;
    if (input.platform === "win32") {
      pid =
        executable === undefined
          ? undefined
          : spawnWindowsDetached([executable, ...args], input.logFile, env);
    } else {
      const log = NodeFS.openSync(input.logFile, "a");
      const child = NodeChildProcess.spawn(runner, args, {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, ...env },
      });
      NodeFS.closeSync(log);
      child.unref();
      pid = child.pid;
    }
    if (pid === undefined) return undefined;
    const deadline = Date.now() + input.readyTimeoutMs;
    while (Date.now() < deadline && processExists(pid)) {
      try {
        const value = await readSshRuntimeCompatibility(input.port);
        if (
          value.serverVersion === version &&
          accepts(value.verdict) &&
          value.instanceId !== undefined &&
          value.instanceId !== input.oldInstanceId
        ) {
          writeLaunchRecords(input.stateDir, identity, pid, input.port);
          return pid;
        }
      } catch {
        // Not answering yet.
      }
      await delay(100);
    }
    // Only the child this supervisor started is ever signalled.
    if (processExists(pid)) {
      process.kill(pid, "SIGTERM");
      if (!(await waitForExit(pid, 5000))) process.kill(pid, "SIGKILL");
      await waitForExit(pid, 5000);
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
  if (started !== undefined) {
    NodeFS.rmSync(backup, { recursive: true, force: true });
    NodeFS.rmSync(input.previousRunnerFile, { force: true });
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
  );
  if (restored === undefined)
    return {
      status: "failed",
      reason: `GOAT ${input.targetVersion} and the previous ${input.previousVersion} both failed to start.`,
    };
  NodeFS.rmSync(backup, { recursive: true, force: true });
  NodeFS.rmSync(input.previousRunnerFile, { force: true });
  return { status: "rolled-back", pid: restored, version: input.previousVersion };
};

export const supervise = Command.make("supervise", {
  oldPid: Flag.Int("old-pid"),
  oldInstanceId: Flag.String("old-instance-id"),
  port: Flag.Int("port"),
  baseDir: Flag.String("base-dir"),
  stateDir: Flag.String("state-dir"),
  runnerFile: Flag.String("runner"),
  previousRunnerFile: Flag.String("previous-runner"),
  targetVersion: Flag.String("target-version"),
  previousVersion: Flag.String("previous-version"),
  identity: Flag.String("identity"),
  previousIdentity: Flag.String("previous-identity"),
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
        writeAtomically(resultFile, line);
        if ("reason" in result) process.stderr.write(result.reason + "\n");
        process.stdout.write(line);
      }),
    ),
  ),
);
